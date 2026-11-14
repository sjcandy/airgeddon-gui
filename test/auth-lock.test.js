'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Ejecutar los manejadores reales con sudo simulado y orden asíncrono controlado.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const handlers = {};
  const auth = deferred();
  const started = deferred();
  const revoke = deferred();
  const context = vm.createContext({
    app: { post: (route, handler) => { handlers[route] = handler; } },
    getAuthRecord: () => ({ attempts: 0, lockedUntil: 0, inFlight: 0 }),
    setTimeout: fn => { fn(); },
    sudoWithPassword: () => { started.resolve(); return auth.promise; },
    execFileP: () => revoke.promise,
    clearSudoTimers() {}, logSystem() {}, resetSudoInactivityTimer() {}, startSudoAbsoluteTimer() {},
    Date, SUDO_MAX_LIFETIME_MS: 7200000,
  });
  vm.runInContext(
    'let sudoPassword = null, sudoAuthenticatedAt = 0, activeAuthInFlight = 0, sudoAuthGeneration = 0; const MAX_CONCURRENT_AUTH = 1;\n' +
    section('async function lockSudoSession(', '\nfunction startSudoAbsoluteTimer(') + '\n' +
    section("app.post('/api/auth',", "\napp.get('/api/interfaces',"), context);
  return { handlers, auth, started, revoke, password: () => vm.runInContext('sudoPassword', context) };
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}
test('Una autenticación normal guarda las credenciales', async () => {
  const s = setup(), res = response();
  const request = s.handlers['/api/auth']({ body: { password: 'dummy' }, ip: '127.0.0.1' }, res);
  await s.started.promise;
  s.auth.resolve({ ok: true });
  await request;
  assert.equal(res.statusCode, 200);
  assert.equal(s.password(), 'dummy');
});
test('Bloquear invalida una autenticación pendiente y permite una nueva después', async () => {
  const s = setup(), res = response(), locked = response();
  const request = s.handlers['/api/auth']({ body: { password: 'dummy' }, ip: '127.0.0.1' }, res);
  await s.started.promise;
  const lock = s.handlers['/api/lock']({}, locked);
  s.revoke.resolve({ ok: true });
  await lock;
  s.auth.resolve({ ok: true });
  await request;
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'AUTH_CANCELLED');
  assert.equal(s.password(), null);
  const fresh = response();
  await s.handlers['/api/auth']({ body: { password: 'fresh-dummy' }, ip: '127.0.0.1' }, fresh);
  assert.equal(fresh.statusCode, 200);
  assert.equal(s.password(), 'fresh-dummy');
});
test('La respuesta de bloqueo espera la revocación de sudo', async () => {
  const s = setup(), res = response();
  const lock = s.handlers['/api/lock']({}, res);
  await Promise.resolve();
  assert.equal(res.body, null);
  s.revoke.resolve({ ok: true });
  await lock;
  assert.equal(res.body.ok, true);
});
