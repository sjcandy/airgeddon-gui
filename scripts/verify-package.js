'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(process.argv[2] || '');
const requirePackage = createRequire(path.join(root, 'package.json'));
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      assert.ok(fs.realpathSync(file).startsWith(root + path.sep), 'Enlace fuera del paquete');
      continue;
    }
    assert.equal(fs.statSync(file).mode & 0o022, 0, 'El paquete no admite escritura de grupo/otros');
    if (entry.isDirectory()) walk(file);
  }
}
(async () => {
  walk(root);
  assert.ok(!fs.existsSync(path.join(root, 'node_modules/node-pty/build/config.gypi')));
  const pty = requirePackage('node-pty');
  await new Promise((resolve, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', 'printf package-ready'], { cols: 80, rows: 24 });
    let output = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('PTY sin respuesta')); }, 5000);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.match(output, /package-ready/); resolve(); } catch (err) { reject(err); } });
  });
  const { server, shutdown } = requirePackage('./server.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /airgeddon/i);
  } finally { await shutdown({ exit: false, watchdogMs: 0 }); }
  console.log('Paquete verificado: permisos, módulo nativo, PTY y servidor HTTP');
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
