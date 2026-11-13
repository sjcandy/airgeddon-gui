'use strict';

/**
 * Pruebas de seguridad, aislamiento de procesos (PGID) y ciclo de vida de credenciales.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const pty = require('node-pty');
const {
  getServerPgid,
  getProcessPgid,
  SERVER_PID,
  SERVER_PGID,
  killProcessTree,
  startSudoAbsoluteTimer,
  resetSudoInactivityTimer,
  clearSudoTimers,
  getSudoPassword,
  setSudoPassword,
} = require('../server.js');

test('El PGID objetivo es distinto del PGID del servidor', async () => {
  const serverPgid = getServerPgid();
  assert.ok(serverPgid, 'El PGID del servidor debe ser no vacío');
  assert.equal(typeof serverPgid, 'string');
  assert.equal(serverPgid, SERVER_PGID);

  // 1. Proceso desacoplado (como el escáner airodump-ng con detached: true)
  const detachedChild = spawn('sleep', ['5'], { detached: true });
  assert.ok(detachedChild.pid, 'El subproceso debe tener PID válido');
  const detachedPgid = getProcessPgid(detachedChild.pid);
  assert.ok(detachedPgid, 'El subproceso desacoplado debe tener un PGID');
  assert.notEqual(detachedPgid, serverPgid, 'El PGID del escáner debe ser independiente del PGID del servidor');
  assert.notEqual(detachedPgid, String(process.pid), 'El PGID del escáner no debe ser el PID del servidor');
  try { process.kill(-Number(detachedPgid), 'SIGKILL'); } catch {}

  // 2. Proceso en terminal PTY (como la sesión principal de airgeddon)
  const ptyChild = pty.spawn('bash', ['-c', 'sleep 5'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  assert.ok(ptyChild.pid, 'El proceso PTY debe tener PID válido');
  const ptyPgid = getProcessPgid(ptyChild.pid);
  assert.ok(ptyPgid, 'El proceso PTY debe tener PGID');
  assert.notEqual(ptyPgid, serverPgid, 'El PGID de la sesión PTY debe ser independiente del servidor');
  assert.notEqual(ptyPgid, String(process.pid), 'El PGID de la sesión PTY no debe ser el PID del servidor');
  try { ptyChild.kill('SIGKILL'); } catch {}
});

test('Detener un escaneo no termina el servidor Node.js', async () => {
  const initialPid = process.pid;
  const scanChild = spawn('sleep', ['10'], { detached: true });
  assert.ok(scanChild.pid);

  // Detener el escaneo usando killProcessTree
  await killProcessTree(scanChild.pid, '-9');
  await new Promise((r) => setTimeout(r, 100));

  // El subproceso debe haber terminado
  assert.throws(() => {
    process.kill(scanChild.pid, 0);
  }, /ESRCH/, 'El proceso de escaneo debe haber terminado');

  // El servidor Node.js debe continuar en ejecución
  assert.equal(process.pid, initialPid, 'El PID del servidor debe permanecer inalterado');
  assert.doesNotThrow(() => {
    process.kill(process.pid, 0);
  }, 'El servidor Node.js debe continuar vivo');
});

test('Detener una sesión PTY no termina el servidor Node.js', async () => {
  const initialPid = process.pid;
  const ptyChild = pty.spawn('bash', ['-c', 'sleep 10'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  const ptyPid = ptyChild.pid;
  assert.ok(ptyPid);

  // Detener la sesión PTY usando killProcessTree
  try { ptyChild.kill('SIGKILL'); } catch {}
  await killProcessTree(ptyPid, '-9');
  await new Promise((r) => setTimeout(r, 100));

  // El servidor Node.js debe seguir vivo
  assert.equal(process.pid, initialPid);
  assert.doesNotThrow(() => {
    process.kill(process.pid, 0);
  }, 'El servidor Node.js debe seguir vivo tras terminar la sesión PTY');
});

test('Ningún proceso ajeno a la ejecución recibe señales', async () => {
  // Proceso ajeno / testigo independiente
  const witness = spawn('sleep', ['10'], { detached: true });
  // Proceso objetivo a terminar
  const target = spawn('sleep', ['10'], { detached: true });

  const witnessPid = witness.pid;
  const targetPid = target.pid;

  // Ejecutar killProcessTree contra el objetivo
  await killProcessTree(targetPid, '-9');

  // Intentar ejecutar killProcessTree contra el propio servidor (debe ser bloqueado por las guardas)
  await killProcessTree(SERVER_PID, '-9');
  await killProcessTree(SERVER_PGID, '-9');

  await new Promise((r) => setTimeout(r, 100));

  // El proceso objetivo debe estar muerto
  assert.throws(() => {
    process.kill(targetPid, 0);
  }, /ESRCH/, 'El proceso objetivo debe haberse detenido');

  // El proceso testigo ajeno debe permanecer vivo e intacto
  assert.doesNotThrow(() => {
    process.kill(witnessPid, 0);
  }, 'El proceso ajeno testigo no debe haber recibido señales');

  // El servidor Node.js debe seguir vivo
  assert.doesNotThrow(() => {
    process.kill(process.pid, 0);
  }, 'El servidor Node.js no debe haber recibido señales');

  // Limpieza del testigo
  try { process.kill(-Number(witnessPid), 'SIGKILL'); } catch {}
});

test('Las credenciales sudo se revocan al alcanzar exactamente el límite máximo', async () => {
  clearSudoTimers();
  setSudoPassword('temporal_secret_token');
  assert.equal(getSudoPassword(), 'temporal_secret_token');

  // Configurar límite máximo absoluto de 120 ms
  startSudoAbsoluteTimer(120);

  // Simular actividad continua que pospone el temporizador de inactividad cada 25 ms
  const interval = setInterval(() => {
    resetSudoInactivityTimer();
  }, 25);

  // Esperar a que transcurra el tiempo máximo absoluto (180 ms > 120 ms)
  await new Promise((r) => setTimeout(r, 180));
  clearInterval(interval);

  // La contraseña debe haberse revocado y purgado incondicionalmente
  assert.equal(
    getSudoPassword(),
    null,
    'Las credenciales sudo deben revocarse al alcanzar el límite máximo absoluto a pesar de la actividad'
  );

  clearSudoTimers();
});
