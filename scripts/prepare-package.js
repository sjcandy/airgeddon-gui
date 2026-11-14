'use strict';
// Solo modifica el árbol de staging, nunca la instalación ni node_modules de desarrollo.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'package.json'))) throw new Error('Falta el árbol de staging');
const pty = path.join(root, 'node_modules', 'node-pty');
const native = path.join(pty, 'build', 'Release', 'pty.node');
if (!fs.existsSync(native)) throw new Error('Falta node-pty compilado para esta plataforma');
// Excluir otros sistemas y archivos de compilación con rutas absolutas del equipo.
for (const entry of fs.readdirSync(path.join(pty, 'build'))) {
  if (entry !== 'Release') fs.rmSync(path.join(pty, 'build', entry), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(path.dirname(native))) {
  if (!['pty.node', 'spawn-helper'].includes(entry)) fs.rmSync(path.join(path.dirname(native), entry), { recursive: true, force: true });
}
fs.rmSync(path.join(pty, 'prebuilds'), { recursive: true, force: true });
function walk(dir) {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!target.startsWith(root + path.sep)) throw new Error('Enlace fuera del paquete');
    } else if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) fs.chmodSync(file, entry.name.endsWith('.sh') || entry.name === 'spawn-helper' ? 0o755 : 0o644);
  }
}
walk(root);
