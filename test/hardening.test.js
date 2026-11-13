'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initLocalAuthSecretFile, installUpdateDependencies, isTrustedOrigin, server, SESSION_TOKEN } = require('../server');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hardening-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test('El secreto se reemplaza de forma atómica con permisos 0600', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'session.auth');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  initLocalAuthSecretFile(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').length, 64);
  assert.deepEqual(fs.readdirSync(dir), ['session.auth']);
});
test('Se rechazan enlaces simbólicos y duros sin modificar el destino', (t) => {
  const root = temporary(t);
  const target = path.join(root, 'target');
  fs.writeFileSync(target, 'preserve');
  const dir = path.join(root, 'auth'); fs.mkdirSync(dir);
  const auth = path.join(dir, 'session.auth');
  fs.symlinkSync(target, auth);
  assert.throws(() => initLocalAuthSecretFile(dir), /inseguro/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
  fs.unlinkSync(auth); fs.linkSync(target, auth);
  assert.throws(() => initLocalAuthSecretFile(dir), /inseguro/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});
test('Un directorio de autenticación enlazado se rechaza', (t) => {
  const root = temporary(t); const target = path.join(root, 'real'); fs.mkdirSync(target);
  const linked = path.join(root, 'linked'); fs.symlinkSync(target, linked);
  assert.throws(() => initLocalAuthSecretFile(linked), /inseguro/);
});
test('Los errores de persistencia se propagan y no dejan temporales', (t) => {
  const dir = temporary(t);
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk error'); });
  assert.throws(() => initLocalAuthSecretFile(dir), /disk error/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('El propietario de los archivos se valida antes de reemplazar secretos', (t) => {
  const dir = temporary(t); const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    const stat = original.call(this, file, ...args);
    if (file === dir) Object.defineProperty(stat, 'uid', { value: process.getuid() + 1 });
    return stat;
  });
  assert.throws(() => initLocalAuthSecretFile(dir), /inseguro/);
});
test('La actualización requiere lockfile y propaga el paso nativo fallido', async (t) => {
  const cwd = temporary(t); let calls = [];
  const run = async (cmd, args) => { calls.push([cmd, args]); return { ok: calls.length !== 2, stderr: 'build failed' }; };
  await assert.rejects(installUpdateDependencies({ cwd, run }), { code: 'UPDATE_LOCKFILE_REQUIRED' });
  assert.equal(calls.length, 0);
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  await assert.rejects(installUpdateDependencies({ cwd, run }), { code: 'UPDATE_REBUILD_FAILED' });
  assert.equal(calls.length, 2);
});
test('La actualización comprueba que el módulo recompilado pueda cargarse', async (t) => {
  const cwd = temporary(t); fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  let calls = [];
  await installUpdateDependencies({ cwd, run: async (cmd, args) => { calls.push([cmd, args]); return { ok: true }; } });
  assert.deepEqual(calls[0], ['npm', ['ci', '--omit=dev', '--ignore-scripts']]);
  assert.deepEqual(calls[1], ['npm', ['rebuild', 'node-pty']]);
  assert.equal(calls[2][0], process.execPath);
  let checks = 0;
  await assert.rejects(installUpdateDependencies({ cwd, run: async () => ({ ok: ++checks !== 3 }) }), { code: 'UPDATE_NATIVE_CHECK_FAILED' });
});
test('Los orígenes exigen el puerto real y el transporte HTTP del servidor', () => {
  const req = (origin) => ({ headers: { origin }, socket: { localPort: 45678 } });
  assert.equal(isTrustedOrigin(req('http://127.0.0.1:45678')), true);
  for (const origin of ['http://127.0.0.1:45679', 'http://localhost:3845', 'https://127.0.0.1:45678', 'null', 'https://example.invalid']) {
    assert.equal(isTrustedOrigin(req(origin)), false);
  }
});
test('API equivalente con mayúsculas conserva no-store y rechaza otro puerto', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/api/info', '/API/INFO', '/API/INFO/']) {
      const response = await fetch(base + route, { headers: { 'X-CSRF-Token': SESSION_TOKEN } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
      await response.arrayBuffer();
    }
    const denied = await fetch(base + '/api/info', { headers: { 'X-CSRF-Token': SESSION_TOKEN, Origin: 'http://127.0.0.1:1' } });
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
