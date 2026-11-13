'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { getSocketOwnerUid, isLocalAuthorized } = require('../server');

const socket = { remoteAddress: '127.0.0.1', remotePort: 54321, localAddress: '127.0.0.1', localPort: 3845 };
function encoded(hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (os.endianness() === 'LE') {
    for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  }
  return bytes.toString('hex').toUpperCase();
}
const v4 = encoded('7f000001');
const v4other = encoded('7f000002');
const v6 = encoded('00000000000000000000000000000001');
const mapped = encoded('00000000000000000000ffff7f000001');
function row({ from = v4, to = v4, source = 54321, target = 3845, state = '01', uid = process.getuid() } = {}) {
  const port = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  return `0: ${from}:${port(source)} ${to}:${port(target)} ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 1`;
}
function mockTables(t, tcp = [], tcp6 = []) {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === '/proc/net/tcp') return 'header\n' + tcp.join('\n');
    if (file === '/proc/net/tcp6') return 'header\n' + tcp6.join('\n');
    return original.call(this, file, ...args);
  });
}

test('El propietario se obtiene de la tupla completa IPv4', (t) => {
  mockTables(t, [row({ from: v4other, uid: 111 }), row({ target: 4444, uid: 222 }), row({ uid: 333 })]);
  assert.equal(getSocketOwnerUid(socket), 333);
});
test('Se rechazan filas con igual puerto pero otra dirección o destino', (t) => {
  mockTables(t, [row({ from: v4other }), row({ to: v4other }), row({ target: 4444 }), row({ source: 54322 })]);
  assert.equal(getSocketOwnerUid(socket), null);
});
test('LISTEN y TIME_WAIT nunca acreditan una conexión establecida', (t) => {
  mockTables(t, [row({ state: '0A' }), row({ state: '06' })]);
  assert.equal(getSocketOwnerUid(socket), null);
});
test('Una conexión ambigua falla cerrada aunque los UID coincidan', (t) => {
  mockTables(t, [row(), row()]);
  assert.equal(getSocketOwnerUid(socket), null);
});
test('Un UID inválido y las filas malformadas no autorizan', (t) => {
  mockTables(t, ['invalid', row({ uid: '123junk' })]);
  assert.equal(getSocketOwnerUid(socket), null);
});
test('IPv6 loopback se compara con los extremos completos', (t) => {
  mockTables(t, [], [row({ from: v6, to: v6, uid: 333 })]);
  assert.equal(getSocketOwnerUid({ ...socket, remoteAddress: '::1', localAddress: '::1' }), 333);
});
test('IPv4 mapeada en IPv6 coincide con su identidad IPv4', (t) => {
  mockTables(t, [], [row({ from: mapped, to: mapped, uid: 333 })]);
  assert.equal(getSocketOwnerUid({ ...socket, remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' }), 333);
});
test('Extremos ausentes, puertos inválidos y direcciones externas fallan cerrados', () => {
  for (const bad of [null, 54321, {}, { ...socket, localPort: 0 }, { ...socket, remotePort: 65536 }, { ...socket, remoteAddress: '192.0.2.1' }]) {
    assert.equal(getSocketOwnerUid(bad), null);
  }
});
test('Sin acceso a las tablas del kernel no hay autorización implícita', (t) => {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === '/proc/net/tcp' || file === '/proc/net/tcp6') throw new Error('unavailable');
    return original.call(this, file, ...args);
  });
  assert.equal(getSocketOwnerUid(socket), null);
  assert.equal(isLocalAuthorized({ socket, headers: {}, get: () => null }), false);
});
test('La decisión usa el UID del kernel y no una cabecera enviada por el cliente', (t) => {
  mockTables(t, [row({ uid: process.getuid() + 1 })]);
  assert.equal(isLocalAuthorized({ socket, headers: { 'x-simulate-peer-uid': String(process.getuid()) }, get: () => null }), false);
});
test('El mismo UID legítimo se reconoce sin cabeceras de simulación', (t) => {
  mockTables(t, [row()]);
  assert.equal(isLocalAuthorized({ socket, headers: { 'x-simulate-peer-uid': String(process.getuid() + 1) }, get: () => null }), true);
});
test('Integración: el socket TCP real identifica al usuario actual en Linux', async () => {
  let client;
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const result = new Promise((resolve, reject) => {
      listener.once('connection', (accepted) => {
        try { resolve(getSocketOwnerUid(accepted)); } catch (e) { reject(e); }
        finally { accepted.destroy(); }
      });
    });
    client = net.connect(listener.address().port, '127.0.0.1');
    client.on('error', () => {});
    assert.equal(await result, process.getuid());
  } finally {
    if (client) client.destroy();
    await new Promise((resolve) => listener.close(resolve));
  }
});
