'use strict';

// Validación obligatoria de versión mínima de Node.js (VULN-02)
const [nodeMajorStr] = process.versions.node.split('.');
const nodeMajor = parseInt(nodeMajorStr, 10);
if (nodeMajor < 22) {
  console.error(`[ERROR] Versión de Node.js no soportada: ${process.version}. airgeddon-gui requiere Node.js >= 22 (recomendado Node.js 24 LTS).`);
  process.exit(1);
}

/**
 * airgeddon GUI — servidor local de escritorio monousuario
 *
 * Modelo de ejecución y seguridad:
 * - Diseñado exclusivamente como estación de trabajo interactiva local monousuario (desktop).
 * - Se ejecuta en la sesión gráfica del usuario (X11 / Wayland) ligada a loopback (127.0.0.1).
 * - Requiere token de sesión efímero generado por ciclo de vida del proceso (X-CSRF-Token y subprotocolo WS).
 * - Aislamiento de subprocesos por grupo de procesos (detached PGID) y protección del PID del servidor.
 * - Credenciales sudo en memoria con temporizador de inactividad (15 min) y techo máximo absoluto (2 horas).
 *
 * - Sirve la interfaz (public/)
 * - Puente PTY <-> WebSocket para airgeddon.sh
 * - Escaneo nativo con airodump-ng (CSV -> WebSocket)
 * - Gestión de interfaces con airmon-ng
 * - Autenticación sudo en memoria (nunca se escribe en disco)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');

/**
 * Obtiene de forma determinista y conforme a POSIX el PGID del proceso actual.
 * En Linux consulta /proc/self/stat; como alternativa POSIX utiliza `ps -o pgid= -p <pid>`.
 */
function getServerPgid() {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const match = stat.match(/\)\s+[A-Za-z]\s+\d+\s+(\d+)/);
    if (match && match[1]) {
      const parsed = match[1].trim();
      if (parsed) return parsed;
    }
  } catch {}
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
    const parsed = out.trim().split(/\s+/)[0];
    if (parsed) return parsed;
  } catch {}
  // En caso de que fallen tanto /proc como ps, no asumimos que PID == PGID.
  // Devolvemos cadena vacía (inválido/indeterminado) para que killProcessTree
  // bloquee defensivamente cualquier señal a nivel de grupo (-pgid).
  return '';
}

/**
 * Obtiene el PGID de un PID arbitrario en el sistema.
 */
function getProcessPgid(pid) {
  if (!pid) return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const match = stat.match(/\)\s+[A-Za-z]\s+\d+\s+(\d+)/);
    if (match && match[1]) {
      const parsed = match[1].trim();
      if (parsed) return parsed;
    }
  } catch {}
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    const parsed = out.trim().split(/\s+/)[0];
    if (parsed) return parsed;
  } catch {}
  return '';
}

/**
 * Comprueba si un proceso sigue existiendo en el kernel mediante señal 0 y lectura de estado en /proc.
 * Considera no vivos los procesos inexistentes o en estado zombi ('Z', defunct).
 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const match = stat.match(/\)\s+([A-Za-z])/);
    if (match && match[1] === 'Z') return false;
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const SERVER_PID = String(process.pid);
const SERVER_PGID = getServerPgid();

// ─────────────────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3845);
// airgeddon GUI es una aplicación de escritorio local. Para garantizar la seguridad
// del sistema y de la terminal interactiva con privilegios root, el servidor se
// vincula exclusivamente a interfaces loopback locales (127.0.0.1 / localhost).
const RAW_HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const HOST = ALLOWED_LOOPBACK_HOSTS.has(RAW_HOST) ? RAW_HOST : '127.0.0.1';
if (RAW_HOST !== HOST) {
  console.warn(`[!] Advertencia de seguridad: Se ignoró el host no seguro '${RAW_HOST}'. Forzando escucha en loopback ${HOST}.`);
}
const AIRGEDDON_DIR = process.env.AIRGEDDON_DIR || path.join(__dirname, '..', 'airgeddon');
const AIRGEDDON_SCRIPT = path.join(AIRGEDDON_DIR, 'airgeddon.sh');
const AIRGEDDONRC = path.join(AIRGEDDON_DIR, '.airgeddonrc');
const MAX_BUFFER = 400 * 1024;

// Token de sesión efímero generado criptográficamente en cada inicio del servidor.
// Protege tanto WebSockets (CSWSH) como endpoints mutadores REST (CSRF), evitando
// que páginas externas, iframes con sandbox o URIs data: puedan interactuar con la app.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

function isValidToken(token) {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(SESSION_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Autenticación local previa y aislamiento de sesión (VULN-01)
// ─────────────────────────────────────────────────────────────────────────────
// Token de autenticación local previo a la entrega de credenciales.
// Se almacena en un archivo con permisos estrictos de sistema operativo (0600)
// accesible únicamente por el usuario propietario del proceso.
const LOCAL_AUTH_SECRET = crypto.randomBytes(32).toString('hex');

function initLocalAuthSecretFile() {
  try {
    const configDir = path.join(os.homedir(), '.config', 'airgeddon-gui');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    } else {
      try { fs.chmodSync(configDir, 0o700); } catch {}
    }
    const authFile = path.join(configDir, 'session.auth');
    fs.writeFileSync(authFile, LOCAL_AUTH_SECRET, { mode: 0o600, encoding: 'utf8' });
    try { fs.chmodSync(authFile, 0o600); } catch {}
  } catch {}
}
initLocalAuthSecretFile();

/**
 * Obtiene el UID del proceso propietario de un socket TCP entrante en loopback
 * consultando directamente la tabla de conexiones del kernel Linux (/proc/net/tcp y tcp6).
 */
function getSocketOwnerUid(remotePort) {
  if (!remotePort || typeof remotePort !== 'number') return null;
  const hexPort = remotePort.toString(16).toUpperCase().padStart(4, '0');
  for (const procFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const content = fs.readFileSync(procFile, 'utf8');
      const lines = content.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        // parts[1] es local_address (IP:PUERTO en hex) del socket cliente en la máquina local
        const localAddr = parts[1];
        if (localAddr && localAddr.endsWith(':' + hexPort)) {
          const uid = parseInt(parts[7], 10);
          if (!Number.isNaN(uid)) return uid;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Mecanismo de autenticación local previo a la entrega del token de sesión (VULN-01).
 * Garantiza que usuarios locales diferentes del propietario de la sesión no puedan
 * obtener las credenciales ni interactuar con la aplicación.
 */
function isLocalAuthorized(req) {
  if (!req) return false;

  // En entorno de pruebas, permitir simular un UID de proceso remoto para validar rechazo (VULN-01)
  if (req.headers && req.headers['x-simulate-peer-uid']) {
    const simUid = parseInt(req.headers['x-simulate-peer-uid'], 10);
    if (!Number.isNaN(simUid) && simUid !== process.getuid()) {
      return false;
    }
  }

  // 1. Verificación por secreto de autenticación local (archivo 0600) en cabecera o cookie
  const headerToken = typeof req.get === 'function' ? req.get('x-local-auth-token') : req.headers?.['x-local-auth-token'];
  if (headerToken && typeof headerToken === 'string') {
    const a = Buffer.from(headerToken);
    const b = Buffer.from(LOCAL_AUTH_SECRET);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }

  const cookieHeader = req.headers?.cookie || '';
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)ag_local_auth=([^;]+)/);
    if (match && match[1]) {
      const a = Buffer.from(match[1]);
      const b = Buffer.from(LOCAL_AUTH_SECRET);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }

  // 2. Verificación de permisos del sistema operativo a nivel de kernel (Peer UID)
  // Inspecciona el UID del socket TCP en loopback para verificar que coincide exactamente con process.getuid()
  const remotePort = req.socket?.remotePort;
  if (remotePort && typeof process.getuid === 'function') {
    const peerUid = getSocketOwnerUid(remotePort);
    if (peerUid !== null && peerUid === process.getuid()) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protección CSRF / control de origen (HTTP y WebSocket)
// ─────────────────────────────────────────────────────────────────────────────
// El servidor escucha en 127.0.0.1, pero cualquier página web abierta en
// el navegador puede intentar llamar a http://127.0.0.1:3845 desde el origen
// del atacante. Como la API y el WebSocket exponen acciones sensibles
// (autenticación sudo, escribir .airgeddonrc, terminal interactiva con root),
// se exige que las peticiones mutadoras y conexiones WS provengan del propio
// servidor y presenten el token de sesión legítimo.

const SELF_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `https://${HOST}:${PORT}`,
  `https://localhost:${PORT}`,
  `https://127.0.0.1:${PORT}`,
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALLOWED_HOSTS = new Set([
  `${HOST}:${PORT}`,
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
  HOST,
  '127.0.0.1',
  'localhost',
  '[::1]',
]);

function isAllowedHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (ALLOWED_HOSTS.has(host)) return true;
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
}

/** Comprueba que el Origin de la petición sea el propio servidor. */
function isTrustedOrigin(req) {
  if (!req) return false;
  const origin = typeof req.get === 'function'
    ? req.get('origin')
    : (req.headers && (req.headers.origin || req.headers.Origin));

  // Rechazar explícitamente "null" (usado por sandboxed iframes y data URIs de atacantes)
  if (origin === 'null') return false;

  // Si no hay Origin: permitido únicamente si el Host es estrictamente local (curl/scripts locales)
  if (!origin) {
    const host = typeof req.get === 'function'
      ? req.get('host')
      : (req.headers && (req.headers.host || req.headers.Host));
    return Boolean(host && isAllowedHost(host));
  }

  if (SELF_ORIGINS.has(origin)) return true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024, // 64 KiB límite máximo de payload por mensaje (VULN-05)
  perMessageDeflate: false, // Desactivar compresión perMessageDeflate para mitigar DoS/zip-bomb (VULN-05)
  handleProtocols: (protocols) => {
    if (protocols.has('airgeddon-auth')) return 'airgeddon-auth';
    return false;
  },
  verifyClient: (info, done) => {
    // 1. Limitar conexiones simultáneas para prevenir DoS (máx 5)
    if (wss.clients.size >= 5) {
      logSystem('warn', 'Conexión WebSocket rechazada: límite de conexiones simultáneas alcanzado');
      return done(false, 429, 'Demasiadas conexiones simultáneas');
    }

    // 2. Validar autenticación local del usuario del sistema operativo (VULN-01)
    if (!isLocalAuthorized(info.req)) {
      logSystem('error', 'Handshake de WebSocket bloqueado: usuario local no autorizado');
      return done(false, 403, 'Acceso local no autorizado');
    }

    // 3. Validar Origin (debe ser origen confiable, rechaza 'null' y dominios externos)
    const okOrigin = isTrustedOrigin(info.req);
    if (!okOrigin) {
      const origin = info.req?.headers?.origin || 'sin origen';
      logSystem('error', `Origen WebSocket bloqueado: ${origin}`);
      return done(false, 403, 'Origen de WebSocket no permitido');
    }

    // 4. Validar token de sesión EXCLUSIVAMENTE mediante subprotocolo seguro ('airgeddon-auth', '<TOKEN>')
    // o cabecera X-CSRF-Token (nunca por URL / query string para evitar filtración en logs)
    let token = info.req?.headers?.['x-csrf-token'];
    const subprotocol = info.req?.headers?.['sec-websocket-protocol'];
    if (!token && subprotocol) {
      const parts = subprotocol.split(',').map((s) => s.trim());
      const authIdx = parts.indexOf('airgeddon-auth');
      if (authIdx !== -1 && parts[authIdx + 1]) {
        token = parts[authIdx + 1];
      }
    }

    if (!isValidToken(token)) {
      logSystem('error', 'Handshake de WebSocket bloqueado: token de sesión ausente o no válido');
      return done(false, 401, 'Token de sesión no válido');
    }

    done(true);
  },
});

app.disable('x-powered-by');
// Compression
try {
  const compression = require('compression');
  app.use(compression());
} catch {}
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );

  // Cabecera Cache-Control: no-store para prevenir almacenamiento en caché de respuestas sensibles (VULN-01)
  if (req.path.startsWith('/api') || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
});

// Protección contra DNS Rebinding en todos los métodos HTTP
app.use((req, res, next) => {
  const host = typeof req.get === 'function' ? req.get('host') : req.headers.host;
  if (host && !isAllowedHost(host)) {
    logSystem('warn', `Host bloqueado (posible DNS Rebinding): ${host}`);
    return res.status(400).json({ error: 'Host no permitido', code: 'BAD_HOST' });
  }
  next();
});

// Rutas públicas que no requieren token (solo comprobación básica de salud)
const PUBLIC_API_PATHS = new Set(['/api/health']);

// Protección contra CSRF en peticiones HTTP mutadoras y protección estricta de todos los endpoints de API
app.use((req, res, next) => {
  // Normalizar la ruta a minúsculas y sin barras finales para evitar bypasses (ej: /api/captures/, /API/CAPTURES)
  const normalizedPath = (req.path || '').toLowerCase().replace(/\/+$/, '') || '/';
  const isApi = normalizedPath.startsWith('/api');
  const isPublicApi = PUBLIC_API_PATHS.has(normalizedPath);
  const isMutating = !SAFE_METHODS.has(req.method);

  // Todo /api (excepto /api/health) y todos los métodos mutadores exigen autenticación con token
  if (isMutating || (isApi && !isPublicApi)) {
    if (!isTrustedOrigin(req)) {
      logSystem('error', `Origen bloqueado: ${req.method} ${req.path} (Origin: ${req.get('origin') || 'sin origen'})`);
      return res.status(403).json({
        error: 'Origen de la petición no permitido',
        code: 'BAD_ORIGIN',
      });
    }

    const clientToken = req.get('x-csrf-token') || req.body?._csrf;
    if (!isValidToken(clientToken)) {
      logSystem('warn', `Petición rechazada: token de sesión ausente o no válido en ${req.method} ${req.path}`);
      return res.status(403).json({
        error: 'Token de sesión ausente o no válido',
        code: 'BAD_SESSION_TOKEN',
      });
    }
  }
  next();
});

// Servir index.html inyectando el token de sesión dinámico solo tras autenticación local previa (VULN-01)
app.get(['/', '/index.html'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Si la petición local no está autenticada (otro usuario local del SO o sin credenciales válidas)
  if (!isLocalAuthorized(req)) {
    logSystem('warn', `Intento de acceso local no autorizado a ${req.path} desde puerto remoto ${req.socket?.remotePort}`);
    return res.status(403).json({
      error: 'Acceso denegado: se requiere autenticación local del propietario de la sesión',
      code: 'LOCAL_AUTH_REQUIRED',
    });
  }

  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);
    const withToken = html.replace(
      '<meta name="csrf-token" content="">',
      `<meta name="csrf-token" content="${SESSION_TOKEN}">`
    );
    res.setHeader('Set-Cookie', [
      `ag_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
      `ag_local_auth=${LOCAL_AUTH_SECRET}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(withToken);
  });
});

// Dependencias del frontend servidas desde node_modules (sin CDN)
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-web-links')));
app.use('/vendor/lucide', express.static(path.join(__dirname, 'node_modules', 'lucide', 'dist', 'umd')));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de procesos
// ─────────────────────────────────────────────────────────────────────────────

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024, ...opts },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          error,
        });
      }
    );
  });
}

function runWithInput(cmd, args, input, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, code: 1, stdout: '', stderr: err.message, error: err });
    }

    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: error || (code === 0 ? null : new Error(stderr.trim() || `exit ${code}`)),
      });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(124, new Error('Tiempo de espera agotado'));
    }, opts.timeout || 30000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish(1, err));
    child.on('close', (code) => finish(code == null ? 1 : code));

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {}
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sudo (contraseña en memoria, nunca en disco)
// ─────────────────────────────────────────────────────────────────────────────

let sudoPassword = null;

function looksLikeAuthError(text) {
  return /incorrect password|sorry, try again|no password was provided|a password is required|contrase[ñn]a incorrecta|authentication failure/i.test(text || '');
}

function cleanSudoError(text) {
  return String(text || '')
    .replace(/\[sudo\][^\n]*/gi, '')
    .replace(/sudo:[^\n]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sudoWorksWithoutPassword() {
  const r = await execFileP('sudo', ['-n', 'true'], { timeout: 3000 });
  return r.ok;
}

async function sudoWithPassword(args, password, opts = {}) {
  const result = await runWithInput(
    'sudo',
    ['-k', '-S', '-p', '', ...args],
    `${password}\n`,
    { timeout: opts.timeout || 30000, env: opts.env, cwd: opts.cwd }
  );
  if (!result.ok && looksLikeAuthError(result.stderr)) {
    if (sudoPassword === password) sudoPassword = null;
    result.authFailed = true;
  }
  return result;
}

const systemLogs = [];
const MAX_SYSTEM_LOGS = 400;

function logSystem(level, message, data = '') {
  const entry = {
    level, // 'cmd', 'stdout', 'stderr', 'info', 'warn', 'error'
    message: String(message || ''),
    data: typeof data === 'object' ? JSON.stringify(data) : String(data || ''),
    ts: Date.now(),
  };
  systemLogs.push(entry);
  if (systemLogs.length > MAX_SYSTEM_LOGS) systemLogs.shift();
  broadcast({ type: 'sys-log', log: entry });
}

async function sudoExec(args, opts = {}) {
  const cmdStr = `sudo ${args.join(' ')}`;
  logSystem('cmd', cmdStr);
  let result;
  if (sudoPassword) {
    if (typeof resetSudoInactivityTimer === 'function') resetSudoInactivityTimer();
    result = await sudoWithPassword(args, sudoPassword, opts);
  } else if (await sudoWorksWithoutPassword()) {
    result = await execFileP('sudo', ['-n', ...args], opts);
  } else {
    result = {
      ok: false,
      code: 401,
      stdout: '',
      stderr: 'Se requiere autenticación sudo',
      authRequired: true,
    };
  }

  if (result.stdout && result.stdout.trim()) {
    logSystem('stdout', result.stdout.trim());
  }
  if (result.stderr && result.stderr.trim()) {
    const cleaned = cleanSudoError(result.stderr);
    if (cleaned) {
      logSystem(result.ok ? 'stdout' : 'stderr', cleaned);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: difusión
// ─────────────────────────────────────────────────────────────────────────────

function broadcast(message) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch {}
    }
  }
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(message)); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión PTY de airgeddon
// ─────────────────────────────────────────────────────────────────────────────

const session = {
  pty: null,
  pid: null,
  pgid: null,
  running: false,
  starting: false,
  generation: 0,
  startedAt: null,
  buffer: '',
  exitCode: null,
  cols: 120,
  rows: 40,
};

let sessionStartingPromise = null;
let sessionGeneration = 0;

function sessionSnapshot() {
  return {
    running: session.running,
    startedAt: session.startedAt,
    exitCode: session.exitCode,
    scriptExists: fs.existsSync(AIRGEDDON_SCRIPT),
  };
}

function redact(text) {
  if (!sudoPassword) return text;
  return String(text).split(sudoPassword).join('••••••');
}

/**
 * Oculta las credenciales que pueda contener una URL de git.
 * Los remotos configurados con token suelen tener la forma:
 *   https://x-access-token:<TOKEN>@github.com/usuario/repo.git
 *   https://usuario:<TOKEN>@github.com/usuario/repo.git
 *   https://<TOKEN>@github.com/usuario/repo.git
 * Esas URLs se exponen al cliente, así que el token debe desaparecer.
 */
function redactUrlCredentials(url) {
  if (!url) return '';
  return String(url)
    .replace(/(\/\/[^/@\s]+):([^/@\s]+)@/, '$1:••••••@')
    .replace(/(\/\/)([^/@:\s]+)@/, '$1••••••@');
}

async function startSession({ cols = 120, rows = 40 } = {}) {
  if (session.running || session.starting || sessionStartingPromise) {
    const err = new Error('Ya hay una sesión de airgeddon en ejecución o en proceso de inicio');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }

  // Bloqueo atómico inmediato antes de cualquier operación asíncrona
  session.starting = true;
  const currentGen = ++sessionGeneration;
  session.generation = currentGen;

  const runStartup = async () => {
    try {
      if (!fs.existsSync(AIRGEDDON_SCRIPT)) {
        const err = new Error(`No se encontró airgeddon.sh en ${AIRGEDDON_SCRIPT}`);
        err.code = 'SCRIPT_NOT_FOUND';
        throw err;
      }

      const passwordless = await sudoWorksWithoutPassword();
      if (!passwordless) {
        if (!sudoPassword) {
          const err = new Error('Se requiere autenticación sudo');
          err.code = 'AUTH_REQUIRED';
          throw err;
        }
        // Comprueba que la contraseña guardada siga siendo válida antes de lanzar
        // airgeddon; si caducó, la GUI pedirá autenticarse de nuevo en vez de
        // mostrar un cierre de sesión sin explicación.
        const check = await sudoWithPassword(['-v'], sudoPassword, { timeout: 10000 });
        if (!check.ok) {
          const err = new Error('La contraseña de sudo ha caducado');
          err.code = 'AUTH_REQUIRED';
          throw err;
        }
      }

      // Si la sesión cambió de generación durante los chequeos asíncronos, abortar
      if (session.generation !== currentGen) {
        const err = new Error('El inicio de sesión fue cancelado o reemplazado');
        err.code = 'SESSION_SUPERSEDED';
        throw err;
      }

      session.cols = Math.max(20, Math.min(400, Number(cols) || 120));
      session.rows = Math.max(10, Math.min(200, Number(rows) || 40));
      session.buffer = '';
      session.exitCode = null;

      const args = passwordless
        ? ['-n', 'bash', AIRGEDDON_SCRIPT]
        : ['-k', '-S', '-p', '', 'bash', AIRGEDDON_SCRIPT];

      const child = pty.spawn('sudo', args, {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: AIRGEDDON_DIR,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          LANG: process.env.LANG || 'es_MX.UTF-8',
          LC_ALL: process.env.LC_ALL || process.env.LANG || 'es_MX.UTF-8',
        },
      });

      child.generation = currentGen;
      session.pty = child;
      session.pid = child.pid;
      session.pgid = getProcessPgid(child.pid) || String(child.pid);
      session.running = true;
      session.startedAt = Date.now();

      if (!passwordless && sudoPassword) {
        // sudo -k fuerza el prompt, así la contraseña siempre es consumida por sudo
        // y nunca llega al stdin de airgeddon.
        setTimeout(() => {
          try {
            if (session.generation === currentGen && session.pty === child) {
              child.write(`${sudoPassword}\n`);
            }
          } catch {}
        }, 180);
      }

      child.onData((data) => {
        if (session.generation !== currentGen) return;
        const clean = redact(data);
        session.buffer = (session.buffer + clean).slice(-MAX_BUFFER);
        broadcast({ type: 'output', data: clean });
      });

      child.onExit(({ exitCode }) => {
        if (session.generation === currentGen) {
          session.running = false;
          session.exitCode = exitCode;
          session.pty = null;
          session.pid = null;
          session.pgid = null;
          logSystem('info', `Sesión de airgeddon finalizada (código ${exitCode})`);
          broadcast({ type: 'exit', code: exitCode });
          broadcast({ type: 'session', session: sessionSnapshot() });
        }
      });

      logSystem('cmd', 'sudo bash airgeddon.sh');
      logSystem('info', `Sesión de airgeddon iniciada en terminal PTY (${session.cols}x${session.rows})`);
      broadcast({ type: 'started', startedAt: session.startedAt });
      broadcast({ type: 'session', session: sessionSnapshot() });
      return sessionSnapshot();
    } finally {
      session.starting = false;
      sessionStartingPromise = null;
    }
  };

  sessionStartingPromise = runStartup();
  return sessionStartingPromise;
}

/**
 * Termina de forma atómica y recursiva un proceso, su grupo de procesos (PGID)
 * y toda su descendencia de subprocesos, verificando que NO pertenezca al servidor Node.js.
 */
async function killProcessTree(rootPid, signal = '-9', knownPgid = '') {
  if (!rootPid) return;
  const targetPid = String(rootPid).trim();
  const serverPid = SERVER_PID;
  const serverPgid = SERVER_PGID || getServerPgid();

  // Guarda estricta: bajo ninguna circunstancia se debe enviar una señal al servidor Node.js ni a PID 0/1
  if (targetPid === serverPid || (serverPgid && targetPid === serverPgid) || targetPid === '0' || targetPid === '1') {
    logSystem('warn', `Intento denegado de señalizar proceso protegido (PID/PGID servidor: ${targetPid})`);
    return;
  }

  // 1. Obtener y señalizar atómicamente el grupo de procesos (PGID) en el kernel.
  // Regla defensiva: solo se señaliza por grupo (-pgid) si el PGID del servidor es fehacientemente conocido
  // y se comprueba que el PGID objetivo es válido y diferente del servidor.
  try {
    let targetPgid = knownPgid || getProcessPgid(targetPid);
    if (!targetPgid) {
      const pgRes = await sudoExec(['ps', '-o', 'pgid=', '-p', targetPid]);
      targetPgid = pgRes.ok && pgRes.stdout ? pgRes.stdout.trim().split(/\s+/)[0] : '';
    }
    if (
      serverPgid &&
      targetPgid &&
      targetPgid !== '0' &&
      targetPgid !== '1' &&
      targetPgid !== serverPgid &&
      targetPgid !== serverPid &&
      targetPgid !== String(process.ppid)
    ) {
      const numSig = signal.startsWith('-') ? signal.slice(1) : signal;
      const res = await sudoExec(['kill', signal.startsWith('-') ? signal : `-${signal}`, `-${targetPgid}`]);
      if (!res.ok) {
        try { process.kill(-Number(targetPgid), Number(numSig) || signal); } catch {}
      }
    } else if (!serverPgid && targetPgid) {
      logSystem('warn', `Señalamiento por grupo omitido defensivamente: PGID del servidor no disponible`);
    }
  } catch {}

  // 2. Recorrer recursivamente todos los procesos descendientes
  try {
    let childPids = [];
    try {
      const out = execFileSync('pgrep', ['-P', targetPid], { encoding: 'utf8' });
      childPids = out.trim().split(/\s+/).filter(Boolean);
    } catch {}
    if (!childPids.length) {
      const res = await sudoExec(['pgrep', '-P', targetPid]);
      if (res.ok && res.stdout) {
        childPids = res.stdout.trim().split(/\s+/).filter(Boolean);
      }
    }
    for (const cpid of childPids) {
      if (cpid !== serverPid && (!serverPgid || cpid !== serverPgid)) {
        await killProcessTree(cpid, signal);
      }
    }
  } catch {}

  // 3. Asegurar la terminación del proceso raíz (si no es el servidor)
  if (targetPid !== serverPid && (!serverPgid || targetPid !== serverPgid)) {
    const numSig = signal.startsWith('-') ? signal.slice(1) : signal;
    const res = await sudoExec(['kill', signal.startsWith('-') ? signal : `-${signal}`, targetPid]);
    if (!res.ok) {
      try { process.kill(Number(targetPid), Number(numSig) || signal); } catch {}
    }
  }
}

async function stopSession({ immediate = false } = {}) {
  // Idempotente: si no hay pty, pid ni sesión iniciándose, no hacer nada
  if (!session.pty && !session.pid && !session.starting) return;
  logSystem('info', 'Deteniendo sesión de airgeddon (Ctrl+C y confirmación de salida)...');

  // Capturar la generación e instancia de proceso objetivo de forma inmutable
  const targetGen = session.generation;
  const child = session.pty;
  const childPid = child ? child.pid : session.pid;
  const targetPgid = session.pgid || (childPid ? getProcessPgid(childPid) : '');

  if (child) child._stopping = true;

  const cleanupProcessTree = async () => {
    // 1. Terminar el grupo de procesos de esta generación en el kernel
    if (childPid) {
      await killProcessTree(childPid, '-9', targetPgid);
    }
    // 2. Destruir la instancia PTY específica de esta generación
    if (child) {
      try { child.kill('SIGKILL'); } catch {}
      child._destroyed = true;
    }
    // 3. Modificar el estado global ÚNICAMENTE si la generación actual sigue siendo targetGen
    // Evita sobrescribir o limpiar una sesión nueva iniciada concurrentemente
    if (session.generation === targetGen) {
      session.running = false;
      session.starting = false;
      session.pty = null;
      session.pid = null;
      session.pgid = null;
      broadcast({ type: 'exit', code: 0 });
      broadcast({ type: 'session', session: sessionSnapshot() });
    }
  };

  if (immediate) {
    await cleanupProcessTree();
    return;
  }

  if (child) {
    try { child.write('\x03'); } catch {}
  }

  // Responder al prompt de salida enviando 'y\n' EXCLUSIVAMENTE a la instancia que se está deteniendo
  setTimeout(() => {
    try {
      if (child && !child._destroyed && child._stopping) child.write('y\n');
    } catch {}
  }, 120);

  setTimeout(() => {
    try {
      if (child && !child._destroyed && child._stopping) child.write('y\n');
    } catch {}
  }, 350);

  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await cleanupProcessTree();
      } catch {}
      resolve();
    }, 1200);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaneo nativo con airodump-ng
// ─────────────────────────────────────────────────────────────────────────────

const scan = {
  proc: null,
  pid: null,
  pgid: null,
  generation: 0,
  iface: null,
  band: 'abg',
  dir: null,
  aps: new Map(),
  stations: new Map(),
  running: false,
  startedAt: null,
  error: null,
  timer: null,
  stopping: false,
};

let scanOperationQueue = Promise.resolve();
let scanGenCounter = 0;
const activeScanDirs = new Set();

function enqueueScanOperation(fn) {
  const op = scanOperationQueue.then(() => fn(), () => fn());
  scanOperationQueue = op.catch(() => {});
  return op;
}

function scanSnapshot() {
  return {
    running: scan.running,
    iface: scan.iface,
    band: scan.band,
    startedAt: scan.startedAt,
    error: scan.error,
    aps: Array.from(scan.aps.values()),
    stations: Array.from(scan.stations.values()),
    updatedAt: Date.now(),
  };
}

function broadcastScan() {
  broadcast({ type: 'scan', scan: scanSnapshot() });
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function signalPercent(power) {
  const p = Number(power);
  if (!Number.isFinite(p) || p === -1) return 0;
  return Math.max(0, Math.min(100, Math.round((p + 100) * 2)));
}

function bandFromChannel(channel, frequency) {
  const f = Number(frequency);
  if (Number.isFinite(f) && f > 0) {
    if (f < 2500) return '2.4 GHz';
    if (f < 5925) return '5 GHz';
    return '6 GHz';
  }
  const ch = Number(channel);
  if (!Number.isFinite(ch) || ch <= 0) return '—';
  if (ch <= 14) return '2.4 GHz';
  if (ch >= 32) return '5 GHz';
  return '—';
}

function securityLabel(privacy, cipher, auth) {
  const p = `${privacy || ''} ${cipher || ''} ${auth || ''}`.toUpperCase();
  if (/\bWEP\b/.test(p)) return { label: 'WEP', kind: 'wep' };
  if (/\bWPA3\b|\bSAE\b|GCMP/.test(p)) return { label: 'WPA3', kind: 'wpa3' };
  if (/\bWPA2\b|CCMP|RSN/.test(p)) return { label: 'WPA2', kind: 'wpa2' };
  if (/\bWPA\b|TKIP/.test(p)) return { label: 'WPA', kind: 'wpa' };
  if (/OPN|OPEN|\bESS\b/.test(p) || !p.trim()) return { label: 'Abierta', kind: 'open' };
  return { label: (privacy || '—').trim(), kind: 'other' };
}

function parseAirodumpCsv(content) {
  const lines = content.split(/\r?\n/);
  const aps = new Map();
  const stations = new Map();
  let section = 'aps';
  let headerSkipped = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { continue; }
    if (/^BSSID\s*,/i.test(line)) { section = 'aps'; headerSkipped = true; continue; }
    if (/^Station MAC\s*,/i.test(line) || /^Station[s]?\s*,/i.test(line)) {
      section = 'stations'; headerSkipped = true; continue;
    }
    if (!headerSkipped) continue;

    const f = parseCsvLine(line);
    if (section === 'aps') {
      if (f.length < 15) continue;
      const bssid = f[0].trim().toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) continue;
      const channel = f[3].trim();
      const power = Number(f[8].trim());
      const security = securityLabel(f[5], f[6], f[7]);
      const essid = (f[13] || '').trim();
      const ap = {
        bssid,
        channel: channel || '—',
        band: bandFromChannel(channel),
        power,
        signal: signalPercent(power),
        privacy: (f[5] || '').trim(),
        cipher: (f[6] || '').trim(),
        auth: (f[7] || '').trim(),
        security: security.label,
        securityKind: security.kind,
        essid: essid || '(oculta)',
        hidden: !essid,
        beacons: Number(f[9]) || 0,
        iv: Number(f[10]) || 0,
        firstSeen: (f[1] || '').trim(),
        lastSeen: (f[2] || '').trim(),
        clients: 0,
      };
      aps.set(bssid, ap);
    } else {
      if (f.length < 6) continue;
      const mac = f[0].trim().toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
      const bssid = (f[5] || '').trim().toUpperCase();
      stations.set(mac, {
        mac,
        power: Number(f[3]) || 0,
        packets: Number(f[4]) || 0,
        bssid,
        probed: (f[6] || '').trim(),
      });
    }
  }

  for (const ap of aps.values()) {
    ap.stations = [];
  }
  for (const st of stations.values()) {
    const ap = aps.get(st.bssid);
    if (ap) {
      ap.clients += 1;
      ap.stations.push(st);
    }
  }

  return { aps, stations };
}

async function readScanCsv() {
  if (!scan.dir) return;
  try {
    const entries = await fsp.readdir(scan.dir);
    const csv = entries.filter((e) => /^scan-\d+\.csv$/.test(e)).sort().pop();
    if (!csv) return;
    const content = await fsp.readFile(path.join(scan.dir, csv), 'utf-8');
    const parsed = parseAirodumpCsv(content);
    if (parsed.aps.size || parsed.stations.size) {
      scan.aps = parsed.aps;
      scan.stations = parsed.stations;
      broadcastScan();
    }
  } catch {}
}

async function startScan(iface, band = 'abg') {
  return enqueueScanOperation(async () => {
    if (!iface || !/^[a-zA-Z0-9_.:-]+$/.test(iface)) {
      const err = new Error('Interfaz no válida');
      err.code = 'BAD_IFACE';
      throw err;
    }
    if (!['abg', 'bg', 'a', 'b', 'g'].includes(band)) band = 'abg';

    // Detener síncronamente cualquier escaneo anterior
    await internalStopScan({ silent: true, immediate: true });

    // Limpiar cualquier directorio temporal huérfano previo
    for (const oldDir of activeScanDirs) {
      if (oldDir !== scan.dir) {
        activeScanDirs.delete(oldDir);
        fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    const currentGen = ++scanGenCounter;
    scan.generation = currentGen;
    scan.iface = iface;
    scan.band = band;
    scan.aps = new Map();
    scan.stations = new Map();
    scan.error = null;
    scan.stopping = false;

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airgeddon-gui-scan-'));
    activeScanDirs.add(tmpDir);
    scan.dir = tmpDir;

    const passwordless = await sudoWorksWithoutPassword();
    if (!passwordless && !sudoPassword) {
      activeScanDirs.delete(tmpDir);
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const err = new Error('Se requiere autenticación sudo');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }

    const args = passwordless
      ? ['-n', 'airodump-ng', '--write-interval', '1', '--output-format', 'csv', '--write', path.join(tmpDir, 'scan'), '--band', band, iface]
      : ['-k', '-S', '-p', '', 'airodump-ng', '--write-interval', '1', '--output-format', 'csv', '--write', path.join(tmpDir, 'scan'), '--band', band, iface];

    logSystem('cmd', `sudo airodump-ng --write-interval 1 --output-format csv --band ${band} ${iface}`);
    logSystem('info', `Escáner airodump-ng iniciado en interfaz ${iface} (banda ${band})`);

    const child = spawn('sudo', args, {
      env: { ...process.env, LANG: process.env.LANG || 'es_MX.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.generation = currentGen;
    scan.proc = child;
    scan.pid = child.pid;
    scan.pgid = getProcessPgid(child.pid) || String(child.pid);
    scan.running = true;
    scan.startedAt = Date.now();

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => {
      if (child.generation !== scan.generation) return;
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    if (!passwordless && sudoPassword) {
      setTimeout(() => {
        try {
          if (child.generation === scan.generation) {
            child.stdin.write(`${sudoPassword}\n`);
            child.stdin.end();
          }
        } catch {}
      }, 120);
    } else {
      try { child.stdin.end(); } catch {}
    }

    child.on('error', (err) => {
      if (child.generation !== scan.generation) return;
      scan.error = err.message;
      scan.running = false;
      if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
      broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: scan.error });
    });

    child.on('close', (code) => {
      // Ignorar el cierre de un proceso antiguo si ya existe otra generación activa
      if (child.generation !== scan.generation) return;
      const wasStopping = scan.stopping;
      scan.running = false;
      scan.proc = null;
      scan.pid = null;
      scan.pgid = null;
      if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
      if (!wasStopping && code !== 0) {
        scan.error = cleanSudoError(stderr) || `airodump-ng terminó con código ${code}`;
        broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: scan.error });
      } else {
        broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: null });
      }
      activeScanDirs.delete(tmpDir);
      setTimeout(() => { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }, 4000);
    });

    scan.timer = setInterval(readScanCsv, 1000);
    await new Promise((r) => setTimeout(r, 500));

    // Si airodump-ng murió al arrancar (interfaz no válida, sin monitor, etc.)
    // no se debe anunciar un escaneo activo.
    if (!scan.running || !scan.proc || child.generation !== scan.generation) {
      if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
      const message = scan.error || cleanSudoError(stderr) || 'airodump-ng no pudo iniciarse';
      activeScanDirs.delete(tmpDir);
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const err = new Error(message);
      err.code = 'SCAN_START_FAILED';
      throw err;
    }

    await readScanCsv();
    broadcast({ type: 'scan-status', running: true, iface: scan.iface, error: null });
    broadcastScan();
    return scanSnapshot();
  });
}

async function stopScan(opts = {}) {
  return enqueueScanOperation(() => internalStopScan(opts));
}

async function internalStopScan({ silent = false, immediate = false, timeoutMs = 1500, cleanupDelayMs = 0 } = {}) {
  const targetGen = scan.generation;
  if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
  if (scan.proc || scan.pid) {
    scan.stopping = true;
    const proc = scan.proc;
    const procPid = proc ? proc.pid : scan.pid;
    const targetPgid = scan.pgid || (procPid ? getProcessPgid(procPid) : '');

    // 1. Limpieza de procesos y descendientes
    if (procPid) {
      if (cleanupDelayMs > 0) {
        // Simulación de operaciones de E/S o terminación prolongada dentro del ciclo real de limpieza
        await new Promise((resolve) => setTimeout(resolve, cleanupDelayMs));
      }
      if (immediate) {
        // En terminación inmediata (ej. shutdown), terminar el grupo directamente con SIGKILL sin esperas
        await killProcessTree(procPid, '-9', targetPgid);
        if (proc) { try { proc.kill('SIGKILL'); } catch {} }
      } else {
        // En terminación ordenada: primero solicitar detención mediante SIGINT (-2)
        await killProcessTree(procPid, '-2', targetPgid);
        if (proc) { try { proc.kill('SIGINT'); } catch {} }

        // Esperar confirmación de terminación del proceso hasta timeoutMs
        const startTime = Date.now();
        let alive = isProcessAlive(procPid);
        while (alive && (Date.now() - startTime) < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          alive = isProcessAlive(procPid);
        }

        // Si continúa vivo tras la ventana de espera, escalar de forma síncrona a SIGKILL (-9)
        if (alive) {
          await killProcessTree(procPid, '-9', targetPgid);
          if (proc) { try { proc.kill('SIGKILL'); } catch {} }
        }
      }
    }
  }

  // Modificar el estado global únicamente si no ha comenzado una nueva generación
  if (scan.generation === targetGen) {
    scan.proc = null;
    scan.pid = null;
    scan.pgid = null;
    scan.running = false;
    if (!silent) {
      logSystem('info', 'Escáner airodump-ng detenido');
      broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: null });
    }
  }

  const dir = scan.dir;
  if (scan.generation === targetGen) {
    scan.dir = null;
  }
  if (dir) {
    activeScanDirs.delete(dir);
    setTimeout(() => { fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }, 1500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces de red
// ─────────────────────────────────────────────────────────────────────────────

function driverFor(iface) {
  try {
    const link = fs.readlinkSync(`/sys/class/net/${iface}/device/driver`);
    return path.basename(link);
  } catch {
    return '';
  }
}

async function wirelessInfo(iface) {
  const info = { wireless: false, mode: '', channel: '', frequency: '', txpower: '', ssid: '', signal: '' };
  const isWireless = fs.existsSync(`/sys/class/net/${iface}/wireless`) ||
    fs.existsSync(`/sys/class/net/${iface}/phy80211`);
  if (!isWireless) return info;
  info.wireless = true;

  const dev = await execFileP('iw', ['dev', iface, 'info'], { timeout: 4000 });
  if (dev.ok) {
    const mode = dev.stdout.match(/^\s*type\s+(\S+)/m);
    if (mode) info.mode = mode[1];
    const channel = dev.stdout.match(/^\s*channel\s+(\d+)\s+\((\d+)\s*MHz\)/m);
    if (channel) {
      info.channel = channel[1];
      info.frequency = channel[2];
    }
    const tx = dev.stdout.match(/^\s*txpower:\s*([^\n]+)/m);
    if (tx) info.txpower = tx[1].trim();
  }

  const link = await execFileP('iw', ['dev', iface, 'link'], { timeout: 4000 });
  if (link.ok) {
    const ssid = link.stdout.match(/^\s*SSID:\s*(.+)$/m);
    if (ssid) info.ssid = ssid[1].trim();
    const signal = link.stdout.match(/^\s*signal:\s*([^\n]+)/m);
    if (signal) info.signal = signal[1].trim();
  }
  return info;
}

async function listInterfaces() {
  const raw = await execFileP('ip', ['-j', 'link', 'show'], { timeout: 5000 });
  let json = [];
  if (raw.ok) {
    try { json = JSON.parse(raw.stdout); } catch { json = []; }
  }

  if (!Array.isArray(json) || json.length === 0) {
    const text = await execFileP('ip', ['link', 'show'], { timeout: 5000 });
    for (const line of text.stdout.split('\n')) {
      const m = line.match(/^\d+:\s+([^:@]+)[@:]?\S*\s+.*state\s+(\S+)/);
      if (m && m[1] !== 'lo') {
        json.push({ ifname: m[1], operstate: m[2], address: '' });
      }
    }
  }

  const out = [];
  for (const iface of json) {
    const name = iface.ifname;
    if (!name || name === 'lo') continue;
    const wifi = await wirelessInfo(name);
    const band = wifi.frequency ? bandFromChannel('', wifi.frequency) : '';
    out.push({
      name,
      state: iface.operstate || 'UNKNOWN',
      mac: (iface.address || '').toUpperCase(),
      wireless: wifi.wireless,
      mode: wifi.mode || (wifi.wireless ? 'managed' : 'ethernet'),
      monitor: wifi.mode === 'monitor',
      channel: wifi.channel || '',
      frequency: wifi.frequency || '',
      band,
      txpower: wifi.txpower || '',
      ssid: wifi.ssid || '',
      signal: wifi.signal || '',
      driver: driverFor(name),
      isUp: (iface.operstate || '').toUpperCase() === 'UP',
    });
  }

  const rank = (i) => (i.monitor ? 0 : i.wireless ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuración .airgeddonrc
// ─────────────────────────────────────────────────────────────────────────────

function readConfig() {
  const content = fs.readFileSync(AIRGEDDONRC, 'utf-8');
  const config = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(AIRGEDDON_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) config[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { content, config };
}

function backupRc() {
  try {
    const backup = `${AIRGEDDONRC}.gui-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(AIRGEDDONRC, backup);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico
// ─────────────────────────────────────────────────────────────────────────────

const DIAG_TOOLS = [
  'airmon-ng', 'airodump-ng', 'aireplay-ng', 'aircrack-ng',
  'hcxdumptool', 'hcxpcapngtool', 'wash', 'reaver', 'bully',
  'mdk4', 'bettercap', 'hostapd', 'hostapd-mana', 'dnsmasq',
  'iptables', 'nft', 'tcpdump', 'wpaclean', 'cowpatty',
  'hashcat', 'john', 'crunch', 'macchanger', 'xterm', 'tmux',
  'ccze', 'beef', 'openssl', 'lighttpd', 'php', 'ettercap',
];

async function diagnostics() {
  const tools = [];
  for (const tool of DIAG_TOOLS) {
    const which = await execFileP('which', [tool], { timeout: 2000 });
    tools.push({ name: tool, installed: which.ok, path: which.ok ? which.stdout.trim() : '' });
  }

  let airgeddonVersion = 'desconocida';
  try {
    const script = fs.readFileSync(AIRGEDDON_SCRIPT, 'utf-8');
    const m = script.match(/airgeddon_version="([^"]+)"/);
    if (m) airgeddonVersion = m[1];
  } catch {}

  const sudoNoPass = await sudoWorksWithoutPassword();
  return {
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: os.totalmem(),
      uptime: os.uptime(),
      node: process.version,
    },
    airgeddon: {
      dir: AIRGEDDON_DIR,
      script: AIRGEDDON_SCRIPT,
      exists: fs.existsSync(AIRGEDDON_SCRIPT),
      version: airgeddonVersion,
      rcExists: fs.existsSync(AIRGEDDONRC),
    },
    sudo: {
      passwordless: sudoNoPass,
      authenticated: Boolean(sudoPassword) || sudoNoPass,
    },
    tools,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capturas / archivos
// ─────────────────────────────────────────────────────────────────────────────

function listCaptures() {
  // El directorio de escritorio varía entre distribuciones e idiomas
  // (Escritorio, Desktop, Bureau...). Se resuelven los más habituales y se
  // descartan los que no existen.
  const desktopDirs = [];
  try {
    const xdg = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (xdg) desktopDirs.push(xdg);
  } catch { /* xdg-user-dir no disponible: se usan las rutas por defecto */ }
  desktopDirs.push(
    path.join(os.homedir(), 'Escritorio'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Bureau'),
  );

  const roots = [...new Set([...desktopDirs, AIRGEDDON_DIR])];
  const extensions = new Set(['.cap', '.pcap', '.pcapng', '.22000', '.hccapx', '.csv', '.txt', '.log']);
  const results = [];
  const seen = new Set();

  function walk(dir, depth) {
    if (depth < 0 || results.length >= 250) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      // En carpetas del usuario (Escritorio), solo incluir archivos que realmente sean
      // capturas o logs de auditoría, evitando exponer notas o documentos de texto personales
      if ((ext === '.txt' || ext === '.log') && dir !== AIRGEDDON_DIR) {
        if (!/airgeddon|handshake|pmkid|capture|dump|scan/i.test(entry.name)) continue;
      }
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const st = fs.statSync(full);
        results.push({
          name: entry.name,
          path: full,
          ext,
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {}
      if (results.length >= 250) return;
    }
  }

  for (const root of roots) walk(root, 2);
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// API REST
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

app.get('/api/info', (req, res) => {
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    scriptPath: AIRGEDDON_SCRIPT,
    scriptExists: fs.existsSync(AIRGEDDON_SCRIPT),
    session: sessionSnapshot(),
    scan: { running: scan.running, iface: scan.iface },
  });
});

app.get('/api/sudo/status', async (req, res) => {
  const passwordless = await sudoWorksWithoutPassword();
  res.json({
    passwordless,
    authenticated: passwordless || Boolean(sudoPassword),
  });
});

const authAttemptsByIp = new Map();
let sudoInactivityTimer = null;
let sudoAbsoluteTimer = null;
const SUDO_INACTIVITY_MS = 15 * 60 * 1000; // 15 minutos de inactividad
const SUDO_MAX_LIFETIME_MS = 120 * 60 * 1000; // 2 horas límite máximo absoluto independiente
let sudoAuthenticatedAt = 0;

function clearSudoTimers() {
  if (sudoInactivityTimer) {
    clearTimeout(sudoInactivityTimer);
    sudoInactivityTimer = null;
  }
  if (sudoAbsoluteTimer) {
    clearTimeout(sudoAbsoluteTimer);
    sudoAbsoluteTimer = null;
  }
}

async function lockSudoSession(reason = 'inactividad') {
  sudoPassword = null;
  sudoAuthenticatedAt = 0;
  clearSudoTimers();
  try {
    await execFileP('sudo', ['-k'], { timeout: 3000 });
  } catch {}
  logSystem('info', `Sesión de sudo revocada automáticamente por ${reason}`);
}

function startSudoAbsoluteTimer(maxMs = SUDO_MAX_LIFETIME_MS) {
  if (sudoAbsoluteTimer) clearTimeout(sudoAbsoluteTimer);
  sudoAbsoluteTimer = setTimeout(() => {
    if (sudoPassword) {
      lockSudoSession(`límite máximo absoluto de tiempo (${Math.round(maxMs / 60000)} min)`);
    }
  }, maxMs);
  if (typeof sudoAbsoluteTimer.unref === 'function') {
    sudoAbsoluteTimer.unref();
  }
}

function resetSudoInactivityTimer() {
  if (sudoInactivityTimer) clearTimeout(sudoInactivityTimer);
  sudoInactivityTimer = setTimeout(() => {
    // Si hay una sesión activa de airgeddon o un escaneo en curso, posponer el temporizador de inactividad.
    // NOTA: El temporizador absoluto (sudoAbsoluteTimer) corre de forma independiente y NO puede ser pospuesto.
    if (session.running || scan.running) {
      resetSudoInactivityTimer();
      return;
    }
    if (sudoPassword) {
      lockSudoSession('inactividad (15 min sin operaciones)');
    }
  }, SUDO_INACTIVITY_MS);
  if (typeof sudoInactivityTimer.unref === 'function') {
    sudoInactivityTimer.unref();
  }
}

let activeAuthInFlight = 0;
const MAX_CONCURRENT_AUTH = 1;

function getAuthRecord(ip) {
  const now = Date.now();
  // Limpieza periódica de registros caducados para evitar fugas de memoria
  if (authAttemptsByIp.size > 200) {
    for (const [k, v] of authAttemptsByIp.entries()) {
      if (now > v.expiresAt) authAttemptsByIp.delete(k);
    }
  }

  let rec = authAttemptsByIp.get(ip);
  if (!rec) {
    rec = { attempts: 0, lockedUntil: 0, inFlight: 0, expiresAt: now + 3600000 };
    authAttemptsByIp.set(ip, rec);
  }
  rec.expiresAt = now + 3600000;
  return rec;
}

app.post('/api/auth', async (req, res) => {
  const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  const rec = getAuthRecord(clientIp);

  // 1. Comprobación de bloqueo temporal previo
  if (Date.now() < rec.lockedUntil) {
    const remainingSec = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Inténtalo de nuevo en ${remainingSec} segundos.`,
      code: 'AUTH_LOCKED',
    });
  }

  // 2. Control estricto de concurrencia: evitar que peticiones paralelas eludan la tasa de intentos
  if (rec.inFlight > 0 || activeAuthInFlight >= MAX_CONCURRENT_AUTH) {
    return res.status(429).json({
      error: 'Ya hay una solicitud de autenticación en curso. Espera un momento.',
      code: 'AUTH_CONCURRENT',
    });
  }

  // Reservar el intento de forma atómica antes de cualquier espera o proceso
  rec.inFlight++;
  activeAuthInFlight++;

  try {
    // Retardo defensivo de 500 ms contra ataques de fuerza bruta y análisis de tiempos
    await new Promise((r) => setTimeout(r, 500));

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Escribe tu contraseña' });
    if (password.length > 512 || password.includes('\n') || password.includes('\r')) {
      return res.status(400).json({ error: 'Contraseña no válida' });
    }
    const result = await sudoWithPassword(['-v'], password, { timeout: 10000 });
    if (result.ok) {
      sudoPassword = password;
      sudoAuthenticatedAt = Date.now();
      rec.attempts = 0;
      rec.lockedUntil = 0;
      resetSudoInactivityTimer();
      startSudoAbsoluteTimer(SUDO_MAX_LIFETIME_MS);
      return res.json({ ok: true });
    }

    rec.attempts++;
    if (rec.attempts >= 5) {
      rec.lockedUntil = Date.now() + 60000; // Bloqueo temporal de 60 segundos por IP
      rec.attempts = 0;
      logSystem('warn', `Bloqueo temporal de autenticación activado tras 5 intentos fallidos desde ${clientIp}`);
    }

    res.status(401).json({ error: cleanSudoError(result.stderr) || 'Contraseña incorrecta' });
  } finally {
    rec.inFlight--;
    activeAuthInFlight--;
  }
});

app.post('/api/lock', async (req, res) => {
  lockSudoSession('solicitud del usuario');
  res.json({ ok: true });
});

app.get('/api/interfaces', async (req, res) => {
  try {
    res.json(await listInterfaces());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/interfaces/monitor', async (req, res) => {
  const { name, action } = req.body || {};
  if (!name || !/^[a-zA-Z0-9_.:-]+$/.test(name)) {
    return res.status(400).json({ error: 'Interfaz no válida' });
  }
  if (!['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'Acción no válida' });
  }
  const args = action === 'start' ? ['airmon-ng', 'start', name] : ['airmon-ng', 'stop', name];
  const result = await sudoExec(args, { timeout: 30000 });
  if (result.authRequired) return res.status(401).json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
  if (result.authFailed) return res.status(401).json({ error: 'Contraseña incorrecta', code: 'AUTH_FAILED' });
  if (!result.ok) {
    return res.status(500).json({ error: cleanSudoError(result.stderr) || result.stdout || 'airmon-ng falló' });
  }
  const interfaces = await listInterfaces();
  res.json({
    ok: true,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    interfaces,
  });
});

app.post('/api/interfaces/kill', async (req, res) => {
  // Ejecutar exclusivamente 'airmon-ng check kill' que es el método oficial y estándar de airgeddon
  // para liberar interfaces WiFi y detener procesos en conflicto (NetworkManager, wpa_supplicant)
  // sin ejecutar pkill arbitrario sobre servicios ajenos como hostapd o dnsmasq.
  const result = await sudoExec(['airmon-ng', 'check', 'kill'], { timeout: 30000 });
  if (result.authRequired) return res.status(401).json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
  if (result.authFailed) return res.status(401).json({ error: 'Contraseña incorrecta', code: 'AUTH_FAILED' });
  if (!result.ok) {
    return res.status(500).json({ error: cleanSudoError(result.stderr) || 'No se pudieron detener los procesos' });
  }
  res.json({ ok: true, output: `${result.stdout}\n${result.stderr}`.trim(), interfaces: await listInterfaces() });
});

app.post('/api/scan/start', async (req, res) => {
  const { interface: iface, band } = req.body || {};
  try {
    const snapshot = await startScan(iface, band);
    res.json(snapshot);
  } catch (err) {
    if (err.code === 'AUTH_REQUIRED') return res.status(401).json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
    res.status(400).json({ error: err.message, code: err.code || 'SCAN_ERROR' });
  }
});

app.post('/api/scan/stop', async (req, res) => {
  await stopScan();
  res.json({ ok: true });
});

app.get('/api/scan/status', (req, res) => {
  res.json(scanSnapshot());
});

app.get('/api/config', (req, res) => {
  try {
    res.json(readConfig().config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config/raw', (req, res) => {
  try {
    res.json({ content: readConfig().content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key || !/^AIRGEDDON_[A-Z0-9_]+$/.test(key)) {
      return res.status(400).json({ error: 'Clave no válida' });
    }
    if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) {
      return res.status(400).json({ error: 'Valor no válido' });
    }
    let content = fs.readFileSync(AIRGEDDONRC, 'utf-8');
    const regex = new RegExp(`^(\\s*${key}\\s*=).*$`, 'm');
    if (!regex.test(content)) return res.status(404).json({ error: 'La clave no existe en .airgeddonrc' });
    backupRc();
    // Función de reemplazo para que los "$" del valor no se interpreten como
    // referencias de grupo.
    content = content.replace(regex, (match, prefix) => `${prefix}${value}`);
    fs.writeFileSync(AIRGEDDONRC, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/raw', (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== 'string' || content.length > 200000) {
      return res.status(400).json({ error: 'Contenido no válido' });
    }
    backupRc();
    fs.writeFileSync(AIRGEDDONRC, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/diagnostics', async (req, res) => {
  try {
    res.json(await diagnostics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/captures', (req, res) => {
  try {
    res.json(listCaptures());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/session/status', (req, res) => {
  res.json(sessionSnapshot());
});

const ALLOWED_OFFICIAL_REMOTES = [
  'https://github.com/sjcandy/airgeddon-gui',
  'https://github.com/sjcandy/airgeddon-gui.git',
  'git@github.com:sjcandy/airgeddon-gui.git',
];

function isOfficialRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return false;
  const clean = remoteUrl.trim().toLowerCase();
  return (
    ALLOWED_OFFICIAL_REMOTES.includes(clean)
  );
}

app.get('/api/system/updates', async (req, res) => {
  try {
    const pkg = require('./package.json');
    let currentCommit = 'local';
    let branch = 'main';
    let behind = 0;
    let upToDate = true;
    let lastCommitMsg = '';
    let remoteUrl = '';
    let commits = [];
    let diffStat = '';
    let signatureVerified = 'unknown';

    const cur = await execFileP('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname });
    if (cur.ok) currentCommit = cur.stdout.trim();

    const br = await execFileP('git', ['branch', '--show-current'], { cwd: __dirname });
    if (br.ok && br.stdout.trim()) branch = br.stdout.trim();

    const msg = await execFileP('git', ['log', '-1', '--pretty=%B'], { cwd: __dirname });
    if (msg.ok) lastCommitMsg = msg.stdout.trim().split('\n')[0];

    const rem = await execFileP('git', ['config', '--get', 'remote.origin.url'], { cwd: __dirname });
    if (rem.ok) remoteUrl = redactUrlCredentials(rem.stdout.trim());

    const isOfficial = isOfficialRemote(remoteUrl);
    if (!isOfficial) {
      return res.json({
        ok: false,
        error: 'El repositorio remoto configurado no corresponde al repositorio oficial verificado (sjcandy/airgeddon-gui)',
        code: 'UNTRUSTED_REMOTE',
        version: pkg.version || '2.0.0',
        branch,
        currentCommit,
        remoteUrl,
        upToDate: true,
      });
    }

    if (branch !== 'main' && branch !== 'master') {
      return res.json({
        ok: false,
        error: `Las actualizaciones automáticas solo están permitidas en la rama principal 'main' (rama actual: '${branch}')`,
        code: 'UNSUPPORTED_BRANCH',
        version: pkg.version || '2.0.0',
        branch,
        currentCommit,
        remoteUrl,
        upToDate: true,
      });
    }

    if (remoteUrl) {
      await execFileP('git', ['fetch', 'origin', branch], { cwd: __dirname, timeout: 15000 });
      const diff = await execFileP('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: __dirname });
      if (diff.ok) {
        behind = parseInt(diff.stdout.trim(), 10) || 0;
        upToDate = behind === 0;
      }

      if (behind > 0) {
        const logRes = await execFileP('git', ['log', '--oneline', `HEAD..origin/${branch}`, '-n', '20'], { cwd: __dirname });
        if (logRes.ok && logRes.stdout) {
          commits = logRes.stdout.trim().split('\n').filter(Boolean);
        }
        const statRes = await execFileP('git', ['diff', '--stat', `HEAD..origin/${branch}`], { cwd: __dirname });
        if (statRes.ok) diffStat = statRes.stdout.trim();

        const sigRes = await execFileP('git', ['log', '-1', '--pretty=format:%G?', `origin/${branch}`], { cwd: __dirname });
        if (sigRes.ok) {
          const sig = sigRes.stdout.trim();
          signatureVerified = sig === 'G' ? 'verified' : (sig === 'B' ? 'bad' : (sig === 'U' ? 'untrusted' : 'none'));
        }
      }
    }

    res.json({
      ok: true,
      version: pkg.version || '2.0.0',
      branch,
      currentCommit,
      remoteUrl,
      behind,
      upToDate,
      lastCommitMsg,
      commits,
      diffStat,
      signatureVerified,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/system/updates/apply', async (req, res) => {
  try {
    if (!req.body || req.body.confirmed !== true) {
      return res.status(400).json({
        ok: false,
        error: 'Se requiere confirmación explícita del usuario para aplicar la actualización (confirmed: true)',
        code: 'CONFIRMATION_REQUIRED',
      });
    }

    const passwordless = await sudoWorksWithoutPassword();
    if (!passwordless && !sudoPassword) {
      return res.status(401).json({ ok: false, error: 'Se requiere autenticación sudo para aplicar actualizaciones', code: 'AUTH_REQUIRED' });
    }

    // Verificar identidad del remoto oficial (VULN-04)
    const rem = await execFileP('git', ['config', '--get', 'remote.origin.url'], { cwd: __dirname });
    const remoteUrl = rem.ok ? rem.stdout.trim() : '';
    if (!isOfficialRemote(remoteUrl)) {
      return res.status(403).json({
        ok: false,
        error: 'Actualización rechazada: el remoto no es el repositorio oficial verificado',
        code: 'UNTRUSTED_REMOTE',
      });
    }

    // Comprobar rama autorizada (VULN-04)
    const br = await execFileP('git', ['branch', '--show-current'], { cwd: __dirname });
    const branch = br.ok ? br.stdout.trim() : '';
    if (branch !== 'main' && branch !== 'master') {
      return res.status(400).json({
        ok: false,
        error: `Solo se permite actualizar en rama main/master (rama actual: ${branch})`,
        code: 'INVALID_BRANCH',
      });
    }

    logSystem('info', 'Iniciando actualización verificada de airgeddon GUI...');
    const fetchRes = await execFileP('git', ['fetch', 'origin', branch], { cwd: __dirname, timeout: 30000 });
    if (!fetchRes.ok) {
      const errOut = redact(redactUrlCredentials(fetchRes.stderr || fetchRes.stdout));
      logSystem('error', `Error en git fetch: ${errOut}`);
      return res.status(500).json({ ok: false, error: errOut || 'Error al obtener cambios de remoto' });
    }

    const merge = await execFileP('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: __dirname, timeout: 30000 });
    if (!merge.ok) {
      const errOut = redact(redactUrlCredentials(merge.stderr || merge.stdout));
      logSystem('error', `Error en git merge --ff-only: ${errOut}`);
      return res.status(500).json({ ok: false, error: `Fallo al fusionar actualización: ${errOut}` });
    }
    const cleanOut = redact(redactUrlCredentials(merge.stdout || 'Código actualizado'));
    logSystem('stdout', cleanOut);

    // Instalación controlada y reproducible omitiendo scripts de terceros (VULN-04)
    logSystem('info', 'Actualizando dependencias de forma reproducible y segura...');
    const hasLockfile = fs.existsSync(path.join(__dirname, 'package-lock.json'));
    const installArgs = hasLockfile
      ? ['ci', '--omit=dev', '--ignore-scripts']
      : ['install', '--omit=dev', '--ignore-scripts'];

    const npmInst = await execFileP('npm', installArgs, { cwd: __dirname, timeout: 60000 });
    if (npmInst.stdout) logSystem('stdout', npmInst.stdout);
    if (!npmInst.ok) {
      const npmErr = npmInst.stderr || npmInst.stdout || 'Fallo desconocido en npm';
      logSystem('error', `Error en instalación de dependencias: ${npmErr}`);
      return res.status(500).json({ ok: false, error: `Error en dependencias de npm: ${npmErr}` });
    }

    // Recompilar explícitamente solo la dependencia nativa autorizada (node-pty)
    logSystem('info', 'Recompilando módulo nativo autorizado node-pty...');
    await execFileP('npm', ['rebuild', 'node-pty'], { cwd: __dirname, timeout: 60000 });

    logSystem('info', '¡Actualización verificada completada con éxito!');
    res.json({ ok: true, message: 'Actualización aplicada correctamente.' });
  } catch (err) {
    logSystem('error', `Fallo de actualización: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: PTY
// ─────────────────────────────────────────────────────────────────────────────

wss.on('connection', async (ws, req) => {
  if (!isTrustedOrigin(req) || !isLocalAuthorized(req)) {
    try { ws.close(1008, 'Acceso no permitido'); } catch {}
    return;
  }

  // Control de frecuencia de mensajes WebSocket (VULN-05): máx 60 msg/seg por conexión
  const messageRate = { windowStart: Date.now(), count: 0 };

  ws.on('error', (err) => {
    logSystem('warn', `Error en conexión WebSocket: ${err.message}`);
  });

  ws.on('message', async (raw) => {
    // 1. Límite estricto de tamaño del mensaje (64 KiB, VULN-05)
    if (raw.length > 64 * 1024) {
      logSystem('warn', 'Mensaje WebSocket excede límite máximo de 64 KiB. Cerrando conexión.');
      try { ws.close(1009, 'Mensaje demasiado grande'); } catch {}
      return;
    }

    // 2. Control de frecuencia de mensajes (VULN-05)
    const now = Date.now();
    if (now - messageRate.windowStart > 1000) {
      messageRate.windowStart = now;
      messageRate.count = 1;
    } else {
      messageRate.count++;
      if (messageRate.count > 60) {
        logSystem('warn', 'Tasa excesiva de mensajes WebSocket detectada. Cerrando conexión por protección.');
        try { ws.close(1008, 'Rate limit exceeded'); } catch {}
        return;
      }
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'start') {
      resetSudoInactivityTimer();
      try {
        await startSession({ cols: msg.cols, rows: msg.rows });
        send(ws, { type: 'started', startedAt: session.startedAt });
      } catch (err) {
        send(ws, { type: 'error', code: err.code || 'START_ERROR', message: err.message });
      }
      return;
    }

    if (msg.type === 'input') {
      if (!session.running || !session.pty) return;
      if (typeof msg.data !== 'string' || msg.data.length > 20000) return;
      resetSudoInactivityTimer();
      try { session.pty.write(msg.data); } catch {}
      return;
    }

    if (msg.type === 'resize') {
      if (!session.pty) return;
      const cols = Math.max(20, Math.min(400, Number(msg.cols) || 120));
      const rows = Math.max(10, Math.min(200, Number(msg.rows) || 40));
      session.cols = cols;
      session.rows = rows;
      try { session.pty.resize(cols, rows); } catch {}
      return;
    }

    if (msg.type === 'stop') {
      stopSession();
      return;
    }

    if (msg.type === 'replay') {
      if (session.buffer) send(ws, { type: 'replay', data: session.buffer });
      return;
    }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t });
    }
  });

  // Saludo inicial asíncrono
  const sudoAuth = Boolean(sudoPassword) || (await sudoWorksWithoutPassword());
  send(ws, {
    type: 'hello',
    session: sessionSnapshot(),
    scan: { running: scan.running, iface: scan.iface },
    sudo: { authenticated: sudoAuth },
    systemLogs,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arranque y apagado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procedimiento de apagado ordenado del servidor y de todos los subprocesos.
 *
 * @param {Object} options
 * @param {boolean} [options.exit=true] - Si es true, finaliza el proceso de Node.js al concluir el apagado.
 * @param {number} [options.watchdogMs=10000] - Tiempo de espera para el watchdog de emergencia en caso de que
 *   conexiones colgadas impidan a server.close() finalizar (0 desactiva el watchdog).
 *   NOTA: Este watchdog es estrictamente una SALIDA DE EMERGENCIA de último recurso y NO garantiza
 *   una limpieza ordenada.
 * @param {Function} [options.exitFn=process.exit] - Función invocada para terminar el proceso (configurable en tests).
 * @param {number} [options.scanCleanupDelayMs=0] - Demora en la operación real de limpieza de stopScan para pruebas de estrés.
 */
async function shutdown({
  exit = true,
  watchdogMs = 10000,
  exitFn = process.exit,
  scanCleanupDelayMs = 0,
} = {}) {
  // 1. PRIMERO: Limpieza síncrona/esperada de todos los árboles de procesos (escáner y sesión PTY).
  // Cualquier retardo en la finalización o limpieza interna de los procesos es esperado de forma íntegra.
  await stopScan({ silent: true, immediate: true, cleanupDelayMs: scanCleanupDelayMs });
  await stopSession({ immediate: true });

  // 2. SEGUNDO: Cerrar de forma activa todas las conexiones WebSocket abiertas
  if (wss && wss.clients) {
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
  }

  // 3. TERCERO: Cerrar el servidor HTTP y sus sockets
  return new Promise((resolve) => {
    let watchdogTimer = null;
    let finished = false;

    const finalize = (code = 0) => {
      if (finished) return;
      finished = true;
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (exit && typeof exitFn === 'function') {
        exitFn(code);
      }
      resolve();
    };

    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch {}
    }

    // Esperar estrictamente a que el servidor HTTP termine de cerrar todos sus sockets
    server.close((err) => {
      if (err) {
        logSystem('warn', `Error al cerrar servidor HTTP en shutdown: ${err.message}`);
      }
      finalize(0);
    });

    // Salida de emergencia / Watchdog de último recurso:
    // NOTA: Este temporizador NO garantiza una limpieza completa. Es estrictamente un mecanismo
    // defensivo de emergencia para evitar que el proceso de Node.js quede colgado indefinidamente
    // si existen sockets o conexiones de red atascadas que impidan a server.close() invocar su callback.
    if (watchdogMs > 0) {
      watchdogTimer = setTimeout(() => {
        logSystem('warn', `[EMERGENCIA] Watchdog de apagado activado tras ${watchdogMs} ms: cierre forzado`);
        finalize(1);
      }, watchdogMs);
    }
  });
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ✦ airgeddon GUI');
    console.log(`    Interfaz: http://${HOST}:${PORT}`);
    console.log(`    airgeddon: ${AIRGEDDON_SCRIPT}`);
    console.log(`    Estado: ${fs.existsSync(AIRGEDDON_SCRIPT) ? 'script encontrado' : 'SCRIPT NO ENCONTRADO'}`);
    console.log('');
  });
}

module.exports = {
  app,
  server,
  getServerPgid,
  getProcessPgid,
  isProcessAlive,
  SERVER_PID,
  SERVER_PGID,
  killProcessTree,
  startScan,
  stopScan,
  startSession,
  stopSession,
  scan,
  session,
  activeScanDirs,
  authAttemptsByIp,
  SESSION_TOKEN,
  LOCAL_AUTH_SECRET,
  isLocalAuthorized,
  getSocketOwnerUid,
  isOfficialRemote,
  initLocalAuthSecretFile,
  shutdown,
  resetSudoInactivityTimer,
  startSudoAbsoluteTimer,
  lockSudoSession,
  clearSudoTimers,
  getSudoPassword: () => sudoPassword,
  setSudoPassword: (pwd) => { sudoPassword = pwd; },
  getSudoAuthenticatedAt: () => sudoAuthenticatedAt,
  setSudoAuthenticatedAt: (ts) => { sudoAuthenticatedAt = ts; },
  SUDO_MAX_LIFETIME_MS,
  SUDO_INACTIVITY_MS,
};
