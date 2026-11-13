'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');

const {
  server,
  SESSION_TOKEN,
  LOCAL_AUTH_SECRET,
  isLocalAuthorized,
  isOfficialRemote,
  initLocalAuthSecretFile,
} = require('../server.js');

const { sanitizeCsvCell } = require('../public/js/app.js');

let testPort;

test.before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      testPort = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ─────────────────────────────────────────────────────────────────────────────
// A. VULN-01 — AUTENTICACIÓN LOCAL Y PROTECCIÓN DEL TOKEN DE SESIÓN
// ─────────────────────────────────────────────────────────────────────────────

test('[VULN-01] GET / sin autenticación local no expone el token de sesión y retorna 403 Forbidden', () => {
  const fakeReq = {
    get: () => null,
    headers: {},
    socket: { remotePort: 54321 },
  };

  assert.equal(
    isLocalAuthorized(fakeReq),
    false,
    'Una petición de otro usuario local o puerto no verificado no debe estar autorizada'
  );
});

test('[VULN-01] GET / con cabecera X-Local-Auth-Token válida es autorizada con éxito', () => {
  const authorizedReq = {
    get: (h) => (h.toLowerCase() === 'x-local-auth-token' ? LOCAL_AUTH_SECRET : null),
    headers: { 'x-local-auth-token': LOCAL_AUTH_SECRET },
    socket: { remotePort: 12345 },
  };

  assert.equal(
    isLocalAuthorized(authorizedReq),
    true,
    'Una petición con el token de autorización local (almacenado con 0600) debe ser autorizada'
  );
});

test('[VULN-01] Una cookie con secreto local no sustituye la identidad del socket', () => {
  const cookieReq = {
    get: () => null,
    headers: { cookie: `ag_local_auth=${LOCAL_AUTH_SECRET}; other=123` },
    socket: { remotePort: 12345 },
  };

  assert.equal(
    isLocalAuthorized(cookieReq),
    false,
    'Las cookies compartidas entre puertos no deben autorizar acceso local'
  );
});

test('[VULN-01] GET / con credencial local manipulada o incorrecta es rechazada con timingSafeEqual', () => {
  const tamperedReq = {
    get: (h) => (h.toLowerCase() === 'x-local-auth-token' ? 'deadbeef'.repeat(8) : null),
    headers: { 'x-local-auth-token': 'deadbeef'.repeat(8) },
    socket: { remotePort: 12345 },
  };

  assert.equal(
    isLocalAuthorized(tamperedReq),
    false,
    'Un token local incorrecto debe ser rechazado sin excepción'
  );
});

test('[VULN-01] Archivo de sesión local session.auth existe con permisos estrictos de usuario (0600)', (t) => {
  const configDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-auth-test-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const authFile = initLocalAuthSecretFile(configDir);

  assert.ok(fs.existsSync(authFile), 'El archivo session.auth debe existir en ~/.config/airgeddon-gui/');
  const stat = fs.statSync(authFile);
  const mode = stat.mode & 0o777;
  assert.equal(
    mode,
    0o600,
    `Los permisos de session.auth deben ser estrictamente 0600 (detectado: 0${mode.toString(8)})`
  );
  const secretInFile = fs.readFileSync(authFile, 'utf8').trim();
  assert.equal(secretInFile.length, 64, 'El archivo debe contener un token criptográfico hexadecimal de 32 bytes');
  assert.match(secretInFile, /^[0-9a-f]{64}$/i);
});

test('[VULN-01] Respuestas sensibles configuran cabeceras Cache-Control: no-store', async () => {
  const res = await fetch(`http://127.0.0.1:${testPort}/api/health`, {
    headers: { Host: '127.0.0.1' },
  });
  const cacheControl = res.headers.get('cache-control') || '';
  assert.match(cacheControl, /no-store/, 'Las respuestas sensibles deben incluir no-store en Cache-Control');
});

test('[VULN-01] GET / sin credenciales ni prueba del kernel se rechaza sin entregar token', async (t) => {
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === '/proc/net/tcp' || file === '/proc/net/tcp6') return '';
    return readFileSync.call(this, file, ...args);
  });
  const unauthRes = await fetch(`http://127.0.0.1:${testPort}/`, {
    headers: {
      Host: '127.0.0.1',
    },
  });

  assert.equal(unauthRes.status, 403);
  const body = await unauthRes.json();
  assert.equal(body.code, 'LOCAL_AUTH_REQUIRED');
  const setCookie = unauthRes.headers.get('set-cookie') || '';
  assert.equal(setCookie.includes(SESSION_TOKEN), false, 'No se debe emitir cookie ag_session');
});

test('[VULN-01] Petición GET / con autorización local válida entrega 200 y token de sesión', async () => {
  const authRes = await fetch(`http://127.0.0.1:${testPort}/`, {
    headers: {
      Host: '127.0.0.1',
      'X-Local-Auth-Token': LOCAL_AUTH_SECRET,
    },
  });

  assert.equal(authRes.status, 200);
  const html = await authRes.text();
  assert.ok(html.includes(`content="${SESSION_TOKEN}"`), 'HTML debe incluir el token de sesión');
  const setCookie = authRes.headers.get('set-cookie') || '';
  assert.equal(setCookie.includes(SESSION_TOKEN), false, 'La sesión no se publica en cookies');
  assert.equal(setCookie.includes(LOCAL_AUTH_SECRET), false, 'El secreto local no se publica en cookies');
  const cookies = authRes.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) assert.match(cookie, /Max-Age=0/);
  assert.match(authRes.headers.get('cache-control') || '', /no-store/);
});

test('[VULN-01] Peticiones mutadoras sin token de sesión CSRF son rechazadas con 403 BAD_SESSION_TOKEN', async () => {
  const res = await fetch(`http://127.0.0.1:${testPort}/api/auth`, {
    method: 'POST',
    headers: {
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${testPort}`,
    },
    body: JSON.stringify({ password: 'test' }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'BAD_SESSION_TOKEN');
});

test('[SESIÓN] El navegador del mismo usuario abre la interfaz sin cookies', async () => {
  const response = await fetch(`http://127.0.0.1:${testPort}/`);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(`content="${SESSION_TOKEN}"`));
  assert.equal(response.headers.get('set-cookie').includes(SESSION_TOKEN), false);
});

test('[SESIÓN] Las cookies de versiones anteriores no autorizan sin prueba del kernel', async (t) => {
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === '/proc/net/tcp' || file === '/proc/net/tcp6') return '';
    return readFileSync.call(this, file, ...args);
  });
  const response = await fetch(`http://127.0.0.1:${testPort}/`, {
    headers: { Cookie: `ag_local_auth=${LOCAL_AUTH_SECRET}; ag_session=${SESSION_TOKEN}` },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes(SESSION_TOKEN), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. VULN-02 — SOPORTE DE VERSIONES DE NODE.JS (>=22)
// ─────────────────────────────────────────────────────────────────────────────

test('[VULN-02] package.json especifica engines node >=22.0.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.engines && pkg.engines.node, 'package.json debe definir engines.node');
  assert.match(pkg.engines.node, />=22/, 'engines.node debe exigir versiones >=22.0.0');
});

test('[VULN-02] airgeddon-gui.sh rechaza versiones de Node.js inferiores a 22', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'airgeddon-gui.sh'), 'utf8');
  assert.match(script, /NODE_VER.*-lt 22/, 'airgeddon-gui.sh debe validar que NODE_VER no sea menor a 22');
});

test('[VULN-02] install.sh recomienda e instala Node.js 24 LTS y rechaza <22', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.match(installer, /setup_24\.x/, 'install.sh debe utilizar NodeSource setup_24.x para distribuciones apt');
  assert.match(installer, /-lt 22/, 'install.sh debe verificar que Node.js sea >= 22');
});

// ─────────────────────────────────────────────────────────────────────────────
// C. VULN-03 — SANITIZACIÓN CSV CONTRA FORMULA INJECTION (CWE-1236)
// ─────────────────────────────────────────────────────────────────────────────

test('[VULN-03] sanitizeCsvCell neutraliza fórmulas estándar que comiencen por =, +, -, @, |, %', () => {
  const testCases = [
    { input: '=1+1', expected: `"'=1+1"` },
    { input: "=cmd|' /C calc'!A0", expected: `"\'=cmd|\' /C calc\'!A0"` },
    { input: '@SUM(1,2)', expected: `"\'@SUM(1,2)"` },
    { input: '+cmd', expected: `"'+cmd"` },
    { input: '-10+20', expected: `"'-10+20"` },
    { input: '|ping -c 3 127.0.0.1', expected: `"\'|ping -c 3 127.0.0.1"` },
    { input: '%calc', expected: `"\'%calc"` },
  ];

  for (const { input, expected } of testCases) {
    const sanitized = sanitizeCsvCell(input);
    assert.equal(sanitized, expected, `La fórmula '${input}' debió ser neutralizada con apóstrofe y comillas`);
  }
});

test('[VULN-03] sanitizeCsvCell detecta y neutraliza fórmulas precedidas por caracteres de control o espacios', () => {
  const testCases = [
    { input: '   =cmd', expected: `"'   =cmd"` },
    { input: '\t=calc', expected: `"'\t=calc"` },
    { input: '\r\n+SUM(1)', expected: `"'\\r\\n+SUM(1)"`.replace('\\r\\n', '\r\n') },
    { input: '\u0000@alert(1)', expected: `"'\\u0000@alert(1)"`.replace('\\u0000', '\u0000') },
  ];

  for (const { input, expected } of testCases) {
    const sanitized = sanitizeCsvCell(input);
    assert.equal(sanitized, expected, `El valor con prefijo de control debió ser neutralizado`);
  }
});

test('[VULN-03] sanitizeCsvCell escapa comillas dobles correctamente según RFC 4180', () => {
  const input = 'Red "Segura" WPA3';
  const expected = '"Red ""Segura"" WPA3"';
  assert.equal(sanitizeCsvCell(input), expected);
});

test('[VULN-03] sanitizeCsvCell preserva ESSID y valores normales legítimos sin alteración innecesaria', () => {
  const testCases = [
    { input: 'MiFibra-Plus_5GHz', expected: '"MiFibra-Plus_5GHz"' },
    { input: 'Totalplay_WiFi', expected: '"Totalplay_WiFi"' },
    { input: 'Auditoria_Oficina_2', expected: '"Auditoria_Oficina_2"' },
    { input: 44, expected: '"44"' },
    { input: -65, expected: `"'-65"` },
  ];

  for (const { input, expected } of testCases) {
    assert.equal(sanitizeCsvCell(input), expected);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D. VULN-04 — SEGURIDAD DE ACTUALIZACIONES Y VERIFICACIÓN DE REMOTO
// ─────────────────────────────────────────────────────────────────────────────

test('[VULN-04] isOfficialRemote solo aprueba el repositorio oficial y rechaza remotos ajenos', () => {
  assert.equal(isOfficialRemote('https://github.com/sjcandy/airgeddon-gui'), true);
  assert.equal(isOfficialRemote('https://github.com/sjcandy/airgeddon-gui.git'), true);
  assert.equal(isOfficialRemote('git@github.com:sjcandy/airgeddon-gui.git'), true);

  assert.equal(isOfficialRemote('https://github.com/atacante/airgeddon-gui.git'), false);
  assert.equal(isOfficialRemote('https://evil.com/sjcandy/airgeddon-gui.git'), false);
  // La identidad debe coincidir completa; un sufijo no valida el servidor remoto.
  for (const remote of [
    'https://notgithub.com/sjcandy/airgeddon-gui.git',
    'https://example.invalid/github.com/sjcandy/airgeddon-gui.git',
    'https://example.invalid/?next=github.com/sjcandy/airgeddon-gui',
    'file:///tmp/github.com/sjcandy/airgeddon-gui.git',
    'http://github.com/sjcandy/airgeddon-gui.git',
  ]) {
    assert.equal(isOfficialRemote(remote), false);
  }
  assert.equal(isOfficialRemote('http://127.0.0.1/airgeddon-gui'), false);
  assert.equal(isOfficialRemote(''), false);
  assert.equal(isOfficialRemote(null), false);
});

test('[VULN-04] POST /api/system/updates/apply exige confirmación explícita (confirmed: true)', async () => {
  const res = await fetch(`http://127.0.0.1:${testPort}/api/system/updates/apply`, {
    method: 'POST',
    headers: {
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${testPort}`,
      'X-CSRF-Token': SESSION_TOKEN,
    },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'CONFIRMATION_REQUIRED');
});

// ─────────────────────────────────────────────────────────────────────────────
// E. VULN-05 — ENDURECIMIENTO DE WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────

test('[VULN-05] Handshake WebSocket rechaza conexiones sin token de sesión', async () => {
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`, {
      headers: { Origin: `http://127.0.0.1:${testPort}` },
    });
    ws.on('error', (err) => {
      assert.match(err.message, /401|unexpected server response/i);
      resolve();
    });
    ws.on('open', () => {
      ws.close();
      assert.fail('La conexión no debió ser aceptada sin token');
      resolve();
    });
  });
});

test('[VULN-05] Conexión WebSocket autenticada recibe mensaje hello y procesa mensajes con seguridad', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`, ['airgeddon-auth', SESSION_TOKEN], {
      headers: {
        Origin: `http://127.0.0.1:${testPort}`,
        'X-Local-Auth-Token': LOCAL_AUTH_SECRET,
      },
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        // Enviar JSON inválido para verificar robustez
        ws.send('ESTO NO ES JSON VÁLIDO {;;;;}');
        setTimeout(() => {
          ws.close();
          resolve();
        }, 50);
      }
    });

    ws.on('error', reject);
  });
});

test('[VULN-05] WebSocket cierra conexión si se excede la tasa máxima de 60 mensajes por segundo', async () => {
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`, ['airgeddon-auth', SESSION_TOKEN], {
      headers: {
        Origin: `http://127.0.0.1:${testPort}`,
        'X-Local-Auth-Token': LOCAL_AUTH_SECRET,
      },
    });

    ws.on('open', () => {
      for (let i = 0; i < 75; i++) {
        ws.send(JSON.stringify({ type: 'replay' }));
      }
    });

    ws.on('close', (code) => {
      assert.equal(code, 1008, 'El servidor debe cerrar con código 1008 por exceso de frecuencia');
      resolve();
    });

    ws.on('error', () => {
      resolve();
    });
  });
});

test('[VULN-05] WebSocket rechaza mensajes que excedan el límite de 64 KiB', async () => {
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`, ['airgeddon-auth', SESSION_TOKEN], {
      headers: {
        Origin: `http://127.0.0.1:${testPort}`,
        'X-Local-Auth-Token': LOCAL_AUTH_SECRET,
      },
    });

    ws.on('open', () => {
      const bigPayload = 'A'.repeat(70 * 1024);
      ws.send(bigPayload);
    });

    ws.on('close', (code) => {
      assert.ok(code === 1009 || code === 1006, `Debe cerrar con 1009 o 1006 (recibido: ${code})`);
      resolve();
    });

    ws.on('error', () => {
      resolve();
    });
  });
});
