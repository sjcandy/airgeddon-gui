'use strict';

/**
 * airgeddon GUI — servidor local
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
const { spawn, execFile, execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');

// ─────────────────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3845);
const HOST = process.env.HOST || '127.0.0.1';
const AIRGEDDON_DIR = process.env.AIRGEDDON_DIR || path.join(__dirname, '..', 'airgeddon');
const AIRGEDDON_SCRIPT = path.join(AIRGEDDON_DIR, 'airgeddon.sh');
const AIRGEDDONRC = path.join(AIRGEDDON_DIR, '.airgeddonrc');
const MAX_BUFFER = 400 * 1024;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Protección CSRF / control de origen
// ─────────────────────────────────────────────────────────────────────────────
// El servidor escucha solo en 127.0.0.1, pero cualquier página web abierta en
// el navegador puede intentar llamar a http://127.0.0.1:3845 desde el origen
// del atacante. Como la API expone acciones sensibles (autenticación sudo,
// escribir .airgeddonrc, matar procesos, aplicar actualizaciones), se exige
// que las peticiones mutadoras envíen un Origin propio.
//
// Los navegadores siempre envían Origin en las peticiones CORS y en las
// peticiones POST/PUT/DELETE. Las peticiones del propio cliente (fetch/XHR
// desde la app) también lo hacen, porque se sirven desde el mismo origen.

const SELF_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Comprueba que el Origin de la petición sea el propio servidor. */
function isTrustedOrigin(req) {
  const origin = req.get('origin');
  // Sin Origin: cliente local (curl, apps nativas, modo escritorio).
  // No es falsificable desde un navegador, así que se acepta.
  if (!origin) return true;
  if (SELF_ORIGINS.has(origin)) return true;
  // Algunos navegadores reportan el origen como "null" en contextos local-file.
  // Se acepta solo si la petición viene del propio servidor por IP.
  if (origin === 'null') {
    const host = req.get('host');
    return !host || host === `${HOST}:${PORT}`;
  }
  return false;
}

app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!isTrustedOrigin(req)) {
    logSystem('error', `Origen bloqueado: ${req.method} ${req.path} (Origin: ${req.get('origin') || 'sin origen'})`);
    return res.status(403).json({
      error: 'Origen de la petición no permitido',
      code: 'BAD_ORIGIN',
    });
  }
  next();
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
  running: false,
  startedAt: null,
  buffer: '',
  exitCode: null,
  cols: 120,
  rows: 40,
};

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
 * Esas URLs se exponen al cliente, así que el token debe desaparecer.
 */
function redactUrlCredentials(url) {
  if (!url) return '';
  return String(url).replace(/(\/\/[^/@\s]+):([^/@\s]+)@/, '$1:••••••@');
}

async function startSession({ cols = 120, rows = 40 } = {}) {
  if (session.running) {
    const err = new Error('Ya hay una sesión de airgeddon en ejecución');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
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

  session.pty = child;
  session.running = true;
  session.startedAt = Date.now();

  if (!passwordless && sudoPassword) {
    // sudo -k fuerza el prompt, así la contraseña siempre es consumida por sudo
    // y nunca llega al stdin de airgeddon.
    setTimeout(() => {
      try { child.write(`${sudoPassword}\n`); } catch {}
    }, 180);
  }

  child.onData((data) => {
    const clean = redact(data);
    session.buffer = (session.buffer + clean).slice(-MAX_BUFFER);
    broadcast({ type: 'output', data: clean });
  });

  child.onExit(({ exitCode }) => {
    session.running = false;
    session.exitCode = exitCode;
    session.pty = null;
    logSystem('info', `Sesión de airgeddon finalizada (código ${exitCode})`);
    broadcast({ type: 'exit', code: exitCode });
    broadcast({ type: 'session', session: sessionSnapshot() });
  });

  logSystem('cmd', 'sudo bash airgeddon.sh');
  logSystem('info', `Sesión de airgeddon iniciada en terminal PTY (${session.cols}x${session.rows})`);
  broadcast({ type: 'started', startedAt: session.startedAt });
  broadcast({ type: 'session', session: sessionSnapshot() });
  return sessionSnapshot();
}

function stopSession() {
  if (!session.pty) return;
  logSystem('info', 'Deteniendo sesión de airgeddon (Ctrl+C y confirmación de salida)...');
  const child = session.pty;
  try { child.write('\x03'); } catch {}
  // Responder automáticamente al prompt de salida: "Detectada interrupción. ¿Quieres realmente salir del script? [Y/n]"
  setTimeout(() => {
    try { if (session.pty) session.pty.write('y\n'); } catch {}
  }, 120);
  setTimeout(() => {
    try { if (session.pty) session.pty.write('y\n'); } catch {}
  }, 350);
  setTimeout(async () => {
    try {
      if (session.pty) {
        try { child.kill('SIGKILL'); } catch {}
        session.pty = null;
      }
      session.running = false;
      broadcast({ type: 'exit', code: 0 });
      broadcast({ type: 'session', session: sessionSnapshot() });
      await sudoExec(['pkill', '-9', '-f', 'bash.*[/ ]airgeddon\\.sh'], { timeout: 3000 });
      const targets = ['airodump-ng', 'aireplay-ng', 'mdk4', 'hostapd', 'dnsmasq', 'wash', 'reaver', 'bully'];
      for (const target of targets) {
        try { await sudoExec(['pkill', '-9', target], { timeout: 2000 }); } catch {}
      }
    } catch {}
  }, 1200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaneo nativo con airodump-ng
// ─────────────────────────────────────────────────────────────────────────────

const scan = {
  proc: null,
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
  if (!iface || !/^[a-zA-Z0-9_.:-]+$/.test(iface)) {
    const err = new Error('Interfaz no válida');
    err.code = 'BAD_IFACE';
    throw err;
  }
  if (!['abg', 'bg', 'a', 'b', 'g'].includes(band)) band = 'abg';

  await stopScan({ silent: true });

  scan.iface = iface;
  scan.band = band;
  scan.aps = new Map();
  scan.stations = new Map();
  scan.error = null;
  scan.stopping = false;
  scan.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airgeddon-gui-scan-'));

  const passwordless = await sudoWorksWithoutPassword();
  if (!passwordless && !sudoPassword) {
    const err = new Error('Se requiere autenticación sudo');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  const args = passwordless
    ? ['-n', 'airodump-ng', '--write-interval', '1', '--output-format', 'csv', '--write', path.join(scan.dir, 'scan'), '--band', band, iface]
    : ['-k', '-S', '-p', '', 'airodump-ng', '--write-interval', '1', '--output-format', 'csv', '--write', path.join(scan.dir, 'scan'), '--band', band, iface];

  logSystem('cmd', `sudo airodump-ng --write-interval 1 --output-format csv --band ${band} ${iface}`);
  logSystem('info', `Escáner airodump-ng iniciado en interfaz ${iface} (banda ${band})`);

  const child = spawn('sudo', args, {
    env: { ...process.env, LANG: process.env.LANG || 'es_MX.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  scan.proc = child;
  scan.running = true;
  scan.startedAt = Date.now();

  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  if (!passwordless && sudoPassword) {
    setTimeout(() => {
      try { child.stdin.write(`${sudoPassword}\n`); child.stdin.end(); } catch {}
    }, 120);
  } else {
    try { child.stdin.end(); } catch {}
  }

  child.on('error', (err) => {
    if (scan.proc !== child) return;
    scan.error = err.message;
    scan.running = false;
    if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
    broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: scan.error });
  });

  child.on('close', (code) => {
    // Ignora el cierre de un proceso antiguo si ya se lanzó otro escaneo.
    if (scan.proc !== child) return;
    const wasStopping = scan.stopping;
    scan.running = false;
    scan.proc = null;
    if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
    if (!wasStopping && code !== 0) {
      scan.error = cleanSudoError(stderr) || `airodump-ng terminó con código ${code}`;
      broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: scan.error });
    } else {
      broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: null });
    }
    const dir = scan.dir;
    scan.dir = null;
    if (dir) setTimeout(() => { fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }, 4000);
  });

  scan.timer = setInterval(readScanCsv, 1000);
  await new Promise((r) => setTimeout(r, 500));

  // Si airodump-ng murió al arrancar (interfaz no válida, sin monitor, etc.)
  // no se debe anunciar un escaneo activo.
  if (!scan.running || !scan.proc) {
    if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
    const message = scan.error || cleanSudoError(stderr) || 'airodump-ng no pudo iniciarse';
    if (scan.dir) {
      const dir = scan.dir;
      scan.dir = null;
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    const err = new Error(message);
    err.code = 'SCAN_START_FAILED';
    throw err;
  }

  await readScanCsv();
  broadcast({ type: 'scan-status', running: true, iface: scan.iface, error: null });
  broadcastScan();
  return scanSnapshot();
}

async function stopScan({ silent = false } = {}) {
  if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
  if (scan.proc) {
    scan.stopping = true;
    try { scan.proc.kill('SIGINT'); } catch {}
    const proc = scan.proc;
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1800);
  }
  scan.proc = null;
  scan.running = false;
  if (!silent) {
    logSystem('info', 'Escáner airodump-ng detenido');
    broadcast({ type: 'scan-status', running: false, iface: scan.iface, error: null });
  }
  const dir = scan.dir;
  scan.dir = null;
  if (dir) {
    setTimeout(() => { fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }, 5000);
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

app.post('/api/auth', async (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) return res.status(400).json({ error: 'Escribe tu contraseña' });
  if (password.length > 512 || password.includes('\n') || password.includes('\r')) {
    return res.status(400).json({ error: 'Contraseña no válida' });
  }
  const result = await sudoWithPassword(['-v'], password, { timeout: 10000 });
  if (result.ok) {
    sudoPassword = password;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: cleanSudoError(result.stderr) || 'Contraseña incorrecta' });
});

app.post('/api/lock', async (req, res) => {
  sudoPassword = null;
  await execFileP('sudo', ['-k'], { timeout: 3000 });
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
  // Matar procesos colgados de auditorías anteriores (airodump, aireplay, etc.)
  // IMPORTANTE: Nunca usar 'airgeddon' a secas con -f porque mataría airgeddon-gui y node.
  const killTargets = [
    'airodump-ng', 'aireplay-ng', 'aircrack-ng', 'mdk4',
    'hostapd', 'dnsmasq', 'wash', 'reaver', 'bully'
  ];
  for (const target of killTargets) {
    try { await sudoExec(['pkill', target], { timeout: 3000 }); } catch {}
  }
  // Para airgeddon, matar exclusivamente el script bash airgeddon.sh sin tocar airgeddon-gui
  try {
    await sudoExec(['pkill', '-f', 'bash.*[/ ]airgeddon\\.sh'], { timeout: 3000 });
  } catch {}
  // También ejecutar airmon-ng check kill para liberar interfaces WiFi
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

app.get('/api/system/updates', async (req, res) => {
  try {
    const pkg = require('./package.json');
    let currentCommit = 'local';
    let branch = 'master';
    let behind = 0;
    let upToDate = true;
    let lastCommitMsg = '';
    let remoteUrl = '';

    const cur = await execFileP('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname });
    if (cur.ok) currentCommit = cur.stdout.trim();

    const br = await execFileP('git', ['branch', '--show-current'], { cwd: __dirname });
    if (br.ok && br.stdout.trim()) branch = br.stdout.trim();

    const msg = await execFileP('git', ['log', '-1', '--pretty=%B'], { cwd: __dirname });
    if (msg.ok) lastCommitMsg = msg.stdout.trim().split('\n')[0];

    const rem = await execFileP('git', ['config', '--get', 'remote.origin.url'], { cwd: __dirname });
    if (rem.ok) remoteUrl = redactUrlCredentials(rem.stdout.trim());

    if (remoteUrl) {
      await execFileP('git', ['fetch', 'origin'], { cwd: __dirname, timeout: 8000 });
      const diff = await execFileP('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: __dirname });
      if (diff.ok) {
        behind = parseInt(diff.stdout.trim(), 10) || 0;
        upToDate = behind === 0;
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
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/system/updates/apply', async (req, res) => {
  try {
    logSystem('info', 'Iniciando actualización de airgeddon GUI...');
    const pull = await execFileP('git', ['pull', '--rebase'], { cwd: __dirname, timeout: 30000 });
    if (!pull.ok) {
      logSystem('error', `Error en git pull: ${pull.stderr || pull.stdout}`);
      return res.status(500).json({ ok: false, error: pull.stderr || pull.stdout || 'Error al descargar actualización' });
    }
    logSystem('stdout', pull.stdout || 'Código actualizado');

    logSystem('info', 'Actualizando dependencias con npm install...');
    const npmInst = await execFileP('npm', ['install', '--production'], { cwd: __dirname, timeout: 60000 });
    if (npmInst.stdout) logSystem('stdout', npmInst.stdout);
    if (!npmInst.ok && npmInst.stderr) logSystem('warn', npmInst.stderr);

    logSystem('info', '¡Actualización completada con éxito!');
    res.json({ ok: true, message: 'Actualización aplicada correctamente.' });
  } catch (err) {
    logSystem('error', `Fallo de actualización: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: PTY
// ─────────────────────────────────────────────────────────────────────────────

wss.on('connection', async (ws) => {
  send(ws, {
    type: 'hello',
    session: sessionSnapshot(),
    scan: { running: scan.running, iface: scan.iface },
    sudo: { authenticated: Boolean(sudoPassword) || (await sudoWorksWithoutPassword()) },
    systemLogs,
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'start') {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Arranque y apagado
// ─────────────────────────────────────────────────────────────────────────────

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (session && session.pty) { try { session.pty.kill(); } catch {} }
  if (scan && scan.proc) { try { scan.proc.kill(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (session && session.pty) { try { session.pty.kill(); } catch {} }
  if (scan && scan.proc) { try { scan.proc.kill(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ✦ airgeddon GUI');
  console.log(`    Interfaz: http://${HOST}:${PORT}`);
  console.log(`    airgeddon: ${AIRGEDDON_SCRIPT}`);
  console.log(`    Estado: ${fs.existsSync(AIRGEDDON_SCRIPT) ? 'script encontrado' : 'SCRIPT NO ENCONTRADO'}`);
  console.log('');
});

async function shutdown() {
  await stopScan({ silent: true });
  if (session.pty) {
    try { session.pty.kill(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
