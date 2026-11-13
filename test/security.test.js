'use strict';

/**
 * Suite de seguridad, aislamiento de procesos (PGID) y ciclo de vida de credenciales.
 *
 * Clasificación de la suite de pruebas:
 *
 * [PRUEBAS UNITARIAS]:
 * - Lógica de guardas de seguridad y bloqueo de señales contra el servidor y procesos ajenos.
 * - Temporizadores en memoria de revocación sudo (expiración por límite absoluto e inactividad).
 * - Revocación hermética y no destructiva de ticket sudo con mock en PATH para verificar 'sudo -k'.
 *
 * [PRUEBAS DE INTEGRACIÓN REAL]:
 * - Resolución y aislamiento de PGID en el kernel POSIX (/proc y ps) para terminales PTY y escaneo desacoplado.
 * - Terminación de escaneo desacoplado y supervivencia del servidor Node.js.
 * - Terminación directa en caliente de terminales PTY y preservación de procesos testigo ajenos.
 * - Ciclo real de stopSession con terminación atómica de árboles y descendientes en PTY.
 * - Detención y escalada síncrona de stopScan() ante procesos que ignoran SIGINT.
 * - Apagado completo del servidor con shutdown({ exit: false }) limpiando árboles completos de
 *   procesos en escaneo y PTY, verificando la terminación de descendientes y la supervivencia de testigos.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const {
  server,
  getServerPgid,
  getProcessPgid,
  isProcessAlive,
  SERVER_PID,
  SERVER_PGID,
  killProcessTree,
  startSession,
  stopSession,
  stopScan,
  shutdown,
  scan,
  session,
  startSudoAbsoluteTimer,
  resetSudoInactivityTimer,
  lockSudoSession,
  clearSudoTimers,
  getSudoPassword,
  setSudoPassword,
} = require('../server.js');

test('[INTEGRACIÓN REAL] El PGID objetivo es distinto del PGID del servidor', async () => {
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

test('[INTEGRACIÓN REAL] Detener un escaneo no termina el servidor Node.js', async () => {
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

test('[INTEGRACIÓN REAL] Detener una sesión PTY en ejecución directa termina el grupo PTY y preserva el servidor y testigos', async () => {
  const initialPid = process.pid;
  // Proceso testigo ajeno independiente
  const witness = spawn('sleep', ['15'], { detached: true });
  const witnessPid = witness.pid;

  // Iniciar proceso PTY interactivo real
  const ptyChild = pty.spawn('bash', ['-c', 'sleep 15'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  const ptyPid = ptyChild.pid;
  assert.ok(ptyPid);

  // Verificar que el PTY está activo antes de la llamada
  assert.doesNotThrow(() => {
    process.kill(ptyPid, 0);
  }, 'El proceso PTY debe estar vivo al iniciar la prueba');

  // Detener DIRECTAMENTE la sesión PTY en ejecución usando killProcessTree (SIN matarlo previamente)
  await killProcessTree(ptyPid, '-9');
  await new Promise((r) => setTimeout(r, 150));

  // 1. El proceso PTY debe haber sido terminado por killProcessTree
  assert.throws(() => {
    process.kill(ptyPid, 0);
  }, /ESRCH/, 'El proceso PTY debe haber terminado tras la llamada a killProcessTree');

  // 2. El proceso testigo ajeno debe haber sobrevivido intacto
  assert.doesNotThrow(() => {
    process.kill(witnessPid, 0);
  }, 'El proceso testigo ajeno debe permanecer vivo');

  // 3. El servidor Node.js debe seguir vivo
  assert.equal(process.pid, initialPid);
  assert.doesNotThrow(() => {
    process.kill(process.pid, 0);
  }, 'El servidor Node.js debe seguir vivo tras terminar la sesión PTY');

  // Limpieza del testigo
  try { process.kill(-Number(witnessPid), 'SIGKILL'); } catch {}
});

test('[INTEGRACIÓN REAL] Ciclo real de stopSession termina el proceso principal PTY y todos sus descendientes sin dejar huérfanos', async () => {
  const initialPid = process.pid;
  // Proceso testigo ajeno independiente
  const witness = spawn('sleep', ['20'], { detached: true });
  const witnessPid = witness.pid;

  // Iniciar sesión con un subproceso PTY que lanza procesos hijos en segundo plano
  const ptyChild = pty.spawn('bash', ['-c', 'sleep 60 & sleep 60 & wait'], {
    cols: 80,
    rows: 24,
  });
  const ptyPid = ptyChild.pid;
  session.pty = ptyChild;
  session.pid = ptyPid;
  session.pgid = getProcessPgid(ptyPid) || String(ptyPid);
  session.running = true;

  // Esperar a que bash cree los subprocesos descendientes en el kernel
  await new Promise((r) => setTimeout(r, 200));

  // Obtener los PIDs descendientes mediante pgrep
  const pgrepOut = execFileSync('pgrep', ['-P', String(ptyPid)], { encoding: 'utf8' });
  const descendantPids = pgrepOut.trim().split(/\s+/).filter(Boolean);
  assert.ok(descendantPids.length >= 1, 'Debe haber al menos un proceso descendiente en ejecución');

  // Verificar que los descendientes y el PTY están vivos antes de stopSession
  assert.doesNotThrow(() => process.kill(ptyPid, 0));
  for (const cpid of descendantPids) {
    assert.doesNotThrow(() => process.kill(Number(cpid), 0));
  }

  // Ejecutar el procedimiento real de stopSession con el orden correcto (limpiar árbol primero)
  await stopSession({ immediate: true });
  await new Promise((r) => setTimeout(r, 150));

  // 1. El proceso PTY principal debe haber terminado
  assert.throws(() => process.kill(ptyPid, 0), /ESRCH/, 'El proceso principal PTY debe estar muerto');

  // 2. TODOS los procesos descendientes deben haber terminado (sin huérfanos)
  for (const cpid of descendantPids) {
    assert.throws(
      () => process.kill(Number(cpid), 0),
      /ESRCH/,
      `El proceso descendiente ${cpid} debe haber sido terminado por stopSession`
    );
  }

  // 3. El proceso testigo ajeno debe seguir vivo
  assert.doesNotThrow(() => process.kill(witnessPid, 0), 'El proceso testigo ajeno debe permanecer vivo');

  // 4. El servidor Node.js debe seguir vivo
  assert.equal(process.pid, initialPid);
  assert.doesNotThrow(() => process.kill(process.pid, 0));

  // Limpieza del testigo
  try { process.kill(-Number(witnessPid), 'SIGKILL'); } catch {}
});

test('[PRUEBA UNITARIA] Ningún proceso ajeno a la ejecución recibe señales y las guardas protegen al servidor', async () => {
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
  if (SERVER_PGID) {
    await killProcessTree(SERVER_PGID, '-9');
  }

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

test('[PRUEBA UNITARIA] Las credenciales sudo se revocan al alcanzar exactamente el límite máximo', async () => {
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

// NOTA: Esta prueba es un test unitario hermético y no destructivo.
// Utiliza un mock en PATH para comprobar que lockSudoSession() ejecuta efectivamente
// 'sudo -k' y gestiona la transición de estado del ticket, evitando requerir la contraseña
// real de root del usuario o invalidar las credenciales activas del sistema operativo.
test('[PRUEBA UNITARIA] lockSudoSession revoca credenciales en memoria y ejecuta sudo -k (prueba unitaria hermética con mock para verificar transición de ticket)', async () => {
  // Configuración de un entorno aislado para verificar la transición de estado del ticket
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-audit-'));
  const sudoScript = path.join(tempDir, 'sudo');
  const ticketFile = path.join(tempDir, '.sudo_ticket');

  fs.writeFileSync(
    sudoScript,
    '#!/bin/sh\n' +
      'TICKET="' + ticketFile + '"\n' +
      'if [ "$1" = "-k" ]; then rm -f "$TICKET"; exit 0; fi\n' +
      'if [ "$1" = "-n" ]; then\n' +
      '  if [ -f "$TICKET" ]; then exit 0; else echo "sudo: a password is required" >&2; exit 1; fi\n' +
      'fi\n' +
      'touch "$TICKET"\n' +
      'exit 0\n',
    { mode: 0o755 }
  );

  const oldPath = process.env.PATH;
  process.env.PATH = tempDir + ':' + oldPath;

  try {
    // 1. Simular sesión autenticada con ticket activo y verificarlo previamente
    execFileSync('sudo', ['-v']);
    let ticketActiveBefore = false;
    try {
      execFileSync('sudo', ['-n', '-v'], { stdio: 'pipe' });
      ticketActiveBefore = true;
    } catch {
      ticketActiveBefore = false;
    }
    assert.equal(ticketActiveBefore, true, 'El ticket previo debe confirmarse como válido y activo antes de la revocación');

    setSudoPassword('clave_para_revocacion');
    assert.equal(getSudoPassword(), 'clave_para_revocacion');

    // 2. Ejecutar la revocación completa de sesión (en memoria y kernel)
    await lockSudoSession('prueba aislada de invalidación en kernel');

    // 3. Verificación en memoria: la contraseña ha sido purgada
    assert.equal(getSudoPassword(), null, 'La contraseña debe haber sido purgada de la memoria');

    // 4. Verificación en el kernel: sudo -k debe haber invalidado el ticket
    let ticketActiveAfter = false;
    try {
      execFileSync('sudo', ['-n', '-v'], { stdio: 'pipe' });
      ticketActiveAfter = true;
    } catch {
      ticketActiveAfter = false;
    }
    assert.equal(ticketActiveAfter, false, 'sudo -k ejecutado por lockSudoSession debe haber invalidado el ticket en el kernel');
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('[INTEGRACIÓN REAL] stopScan() espera la confirmación de salida y escala síncronamente a SIGKILL si el proceso ignora SIGINT', async () => {
  // Proceso desacoplado que ignora deliberadamente SIGINT (trap '' INT) y únicamente finaliza con SIGKILL
  const stubbornScan = spawn('bash', ['-c', 'trap "" INT; sleep 60'], { detached: true });
  const stubbornPid = stubbornScan.pid;
  scan.proc = stubbornScan;
  scan.pid = stubbornPid;
  scan.pgid = getProcessPgid(stubbornPid) || String(stubbornPid);
  scan.running = true;

  await new Promise((r) => setTimeout(r, 100));
  assert.doesNotThrow(() => process.kill(stubbornPid, 0), 'El proceso debe estar vivo inicialmente');

  // Invocar stopScan con una ventana de espera reducida (200 ms) para verificar la escalada
  await stopScan({ silent: true, timeoutMs: 200 });

  // Al retornar stopScan, la escalada a SIGKILL ya debe haber finalizado y confirmado la muerte del proceso
  assert.throws(
    () => process.kill(stubbornPid, 0),
    /ESRCH/,
    'stopScan debe esperar y escalar a SIGKILL completando la limpieza antes de retornar el control'
  );
  assert.equal(scan.running, false);
});

test('[INTEGRACIÓN REAL] shutdown() invoca stopScan y stopSession({ immediate: true }) garantizando la limpieza completa de grupos y descendientes antes del cierre', async () => {
  const initialPid = process.pid;
  const witness = spawn('sleep', ['20'], { detached: true });
  const witnessPid = witness.pid;

  // Iniciar proceso PTY con procesos descendientes
  const ptyChild = pty.spawn('bash', ['-c', 'sleep 60 & sleep 60 & wait'], { cols: 80, rows: 24 });
  const ptyPid = ptyChild.pid;
  session.pty = ptyChild;
  session.pid = ptyPid;
  session.pgid = getProcessPgid(ptyPid) || String(ptyPid);
  session.running = true;

  // Iniciar proceso simulado de escaneo desacoplado con procesos descendientes
  const scanChild = spawn('bash', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: true });
  const scanPid = scanChild.pid;
  scan.proc = scanChild;
  scan.pid = scanPid;
  scan.pgid = getProcessPgid(scanPid) || String(scanPid);
  scan.running = true;

  // Esperar a que el kernel registre los procesos descendientes
  await new Promise((r) => setTimeout(r, 200));

  // Obtener los PIDs de los descendientes de ambos árboles mediante pgrep
  const pgrepPty = execFileSync('pgrep', ['-P', String(ptyPid)], { encoding: 'utf8' });
  const ptyDescendants = pgrepPty.trim().split(/\s+/).filter(Boolean);
  assert.ok(ptyDescendants.length >= 1, 'Deben existir procesos descendientes en el árbol PTY');

  const pgrepScan = execFileSync('pgrep', ['-P', String(scanPid)], { encoding: 'utf8' });
  const scanDescendants = pgrepScan.trim().split(/\s+/).filter(Boolean);
  assert.ok(scanDescendants.length >= 1, 'Deben existir procesos descendientes en el árbol de escaneo');

  // Verificar que todos los procesos (principales y descendientes) están vivos antes del apagado
  assert.doesNotThrow(() => process.kill(ptyPid, 0));
  for (const cpid of ptyDescendants) assert.doesNotThrow(() => process.kill(Number(cpid), 0));
  assert.doesNotThrow(() => process.kill(scanPid, 0));
  for (const cpid of scanDescendants) assert.doesNotThrow(() => process.kill(Number(cpid), 0));

  // Interceptar temporalmente server.close para no finalizar el runner de tests
  const originalClose = server.close.bind(server);
  let closeCalled = false;
  server.close = (cb) => {
    closeCalled = true;
    if (typeof cb === 'function') cb();
    return server;
  };

  try {
    await shutdown({ exit: false });
    assert.equal(closeCalled, true, 'server.close debe haber sido invocado durante el apagado');

    // 1. El proceso PTY principal y todos sus descendientes deben haber terminado
    assert.throws(() => process.kill(ptyPid, 0), /ESRCH/, 'El proceso PTY debe haber terminado');
    for (const cpid of ptyDescendants) {
      assert.throws(() => process.kill(Number(cpid), 0), /ESRCH/, `El descendiente PTY ${cpid} debe haber terminado`);
    }

    // 2. El proceso principal de escaneo y todos sus descendientes deben haber terminado
    assert.throws(() => process.kill(scanPid, 0), /ESRCH/, 'El proceso principal de escaneo debe haber terminado');
    for (const cpid of scanDescendants) {
      assert.throws(
        () => process.kill(Number(cpid), 0),
        /ESRCH/,
        `El proceso descendiente de escaneo ${cpid} debe haber sido terminado por shutdown`
      );
    }

    // 3. El proceso testigo ajeno debe seguir vivo
    assert.doesNotThrow(() => process.kill(witnessPid, 0), 'El testigo ajeno debe seguir vivo');

    // 4. El proceso del servidor Node.js de pruebas debe continuar vivo
    assert.equal(process.pid, initialPid, 'El servidor de pruebas debe mantenerse vivo');
  } finally {
    server.close = originalClose;
    try { process.kill(-Number(witnessPid), 'SIGKILL'); } catch {}
  }
});
