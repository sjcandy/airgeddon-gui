'use strict';

/**
 * Pruebas del parser de pantalla.
 *
 * El parser vive en el navegador (usa `window`), así que se carga en Node
 * exponiendo un `window` mínimo. No requiere DOM ni xterm: recibe las líneas
 * de la pantalla visible tal como las entrega la terminal.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

global.window = global;
require('../public/js/parser.js');

const { analyze } = global.AG.parser;

function screen(lines) {
  return analyze({
    lines,
    cursorY: lines.length - 1,
    rows: lines.length,
    cols: 120,
  });
}

test('detecta el menú principal', () => {
  const result = screen([
    ' airgeddon v12.02 main menu',
    ' 0. Salir del script',
    ' 1. Selecciona otra interfaz de red',
    ' 4. Menú de ataques DoS',
    ' 5. Menú de herramientas Handshake/PMKID/Decloaking',
    '> ',
  ]);
  assert.equal(result.type, 'menu');
  assert.equal(result.context.id, 'main');
  assert.ok(result.items.some((item) => item.key === '4'));
});

test('“Volver al menú principal” no convierte un menú en principal', () => {
  const result = screen([
    ' Menú de ataques DoS',
    ' 0. Volver al menú principal',
    ' 1. Decloaking / Deauth',
    ' 2. Autenticación flood',
    '> ',
  ]);
  assert.equal(result.type, 'menu');
  assert.equal(result.context.id, 'dos');
});

test('detecta una confirmación dentro de un contexto', () => {
  const result = screen([
    ' Menú de ataques DoS',
    ' ¿Quieres continuar? [Y/n]',
  ]);
  assert.equal(result.type, 'confirm');
  assert.equal(result.context.id, 'dos');
});

test('detecta “Pulsa Enter” como acción de continuar', () => {
  const result = screen([
    ' Menú de ataques DoS',
    ' Has elegido el ataque DoS 1',
    ' Pulsa la tecla [Enter] para continuar...',
  ]);
  assert.equal(result.type, 'enter');
});

test('parsea la lista de redes en el formato real de airgeddon', () => {
  const result = screen([
    '',
    ' Seleccionar objetivo',
    '',
    ' Nº  BSSID              CH   BAND       PWR   ENC    ESSID',
    ' 1)   02:00:00:00:00:01  6   2.4Ghz     -50%  WPA2   Lab_Demo_2G',
    ' 2)*  02:00:00:00:00:02  36  5Ghz       -70%  WPA3   Corporate_WiFi',
    ' 3)   02:00:00:00:00:03  -   2.4Ghz      0%   OPN    (Hidden Network)',
    '',
    '> ',
  ]);

  assert.equal(result.type, 'network');
  assert.equal(result.nets.length, 3);

  const [net1, net2, oculta] = result.nets;

  assert.equal(net1.essid, 'Lab_Demo_2G');
  assert.equal(net1.band, '2.4 GHz');
  assert.equal(net1.power, -50);
  assert.equal(net1.signal, 100); // -50 dBm -> 100 %
  assert.equal(net1.securityKind, 'wpa2');

  assert.equal(net2.essid, 'Corporate_WiFi');
  assert.equal(net2.band, '5 GHz');
  assert.equal(net2.signal, 60); // -70 dBm -> 60 %
  assert.equal(net2.hasClients, true);

  assert.equal(oculta.essid, '(oculta)');
  assert.equal(oculta.channel, '—');
  assert.equal(oculta.signal, 0);
  assert.equal(oculta.securityKind, 'open');
  assert.equal(oculta.hasClients, false);
});

test('parsea redes con asterisco pegado al MAC como en airgeddon real', () => {
  const result = screen([
    '26) 02:AA:BB:CC:DD:01  7  2.4Ghz  47%  WPA2  TestAP_Office',
    '32)*02:AA:BB:CC:DD:02  4  2.4Ghz  50%  WPA2  Lab_Client_Network',
    '49)*02:AA:BB:CC:DD:03  9  2.4Ghz  70%  WPA2  Demo_Guest_WiFi',
    '50) 02:AA:BB:CC:DD:04 11  2.4Ghz  77%  WPA2  Audited_Hotspot',
    '',
    '(*) Red con clientes',
    '-----------------------------------------',
    'Selecciona la red objetivo:',
    '> ',
  ]);

  assert.equal(result.type, 'network');
  assert.equal(result.nets.length, 4);
  assert.equal(result.nets[1].n, '32');
  assert.equal(result.nets[1].hasClients, true);
  assert.equal(result.nets[1].bssid, '02:AA:BB:CC:DD:02');
  assert.equal(result.nets[1].essid, 'Lab_Client_Network');
  assert.equal(result.nets[3].n, '50');
  assert.equal(result.nets[3].hasClients, false);
});

test('detecta una petición de texto', () => {
  const result = screen([
    ' Selecciona otra interfaz de red',
    ' Escribe el nombre de la interfaz:',
    '> ',
  ]);
  assert.equal(result.type, 'text');
  assert.match(result.question, /Escribe el nombre/);
});

test('las opciones del menú Evil Twin conservan el texto exacto de airgeddon', () => {
  const result = screen([
    ' Desautenticación para Evil Twin',
    '',
    ' Selecciona una opción del menú:',
    ' ────────────────────────────────────────────',
    ' 0.  Volver al menú de ataques Evil Twin',
    ' ────────────────────────────────────────────',
    ' 1.  Ataque Deauth / Disassoc amok mdk4',
    ' 2.  Ataque Deauth aireplay',
    ' 3.  Ataque Auth DoS',
    ' ────────────────────────────────────────────',
    ' Consejo Con este ataque, intentaremos desautenticar a los clientes del AP legítimo.',
    ' ────────────────────────────────────────────',
    '> ',
  ]);

  assert.equal(result.type, 'menu');
  const byKey = Object.fromEntries(result.items.map((item) => [item.key, item.title]));
  assert.equal(byKey['0'], 'Volver al menú de ataques Evil Twin');
  assert.equal(byKey['1'], 'Ataque Deauth / Disassoc amok mdk4');
  assert.equal(byKey['2'], 'Ataque Deauth aireplay');
  assert.equal(byKey['3'], 'Ataque Auth DoS');
  // El consejo de la consola se conserva como nota informativa.
  assert.match(result.hint, /^Consejo Con este ataque/);
});

test('parsea el menú principal completo de airgeddon v12.02 con sus 14 opciones exactas', () => {
  const result = screen([
    '*********************** Menú principal airgeddon v12.02 ***********************',
    'Interfaz wlan0 seleccionada. Modo: Managed. Bandas soportadas: 2.4Ghz (WiFi4)',
    '',
    'Selecciona una opción del menú:',
    '---------',
    '0.  Salir del script',
    '1.  Selecciona otra interfaz de red',
    '2.  Poner la interfaz en modo monitor',
    '3.  Poner la interfaz en modo managed',
    '---------',
    '4.  Menú de ataques DoS',
    '5.  Menú de herramientas Handshake/PMKID/Decloaking',
    '6.  Menú de descifrado WPA/WPA2 offline',
    '7.  Menú de ataques Evil Twin',
    '8.  Menú de ataques WPS',
    '9.  Menú de ataques WEP',
    '10. Menú de ataques Enterprise',
    '11. Menú de ataques WPA3',
    '---------',
    '12. Acerca de & Créditos / Menciones de patrocinadores',
    '13. Menú de opciones e idioma',
    '---------',
    'Consejo Si instalas el paquete ccze podrás ver algunas partes de airgeddon...',
    '---------',
    '> ',
  ]);
  assert.equal(result.type, 'menu');
  assert.equal(result.context.id, 'main');
  assert.equal(result.items.length, 14);
  const keys = result.items.map((it) => it.key);
  assert.deepEqual(keys, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
});

test('no inventa interacción en una pantalla vacía', () => {
  assert.equal(analyze({ lines: [], cursorY: 0, rows: 0, cols: 80 }), null);
  assert.equal(analyze(null), null);
});

test('detecta error de tarjeta no wifi al intentar modo monitor', () => {
  const result = screen([
    'Esta interfaz enp2s0 no es una tarjeta wifi. No soporta modo monitor',
    'Pulsa la tecla [Enter] para continuar...',
  ]);
  assert.equal(result.type, 'enter');
  assert.equal(result.isError, true);
  assert.equal(result.title, 'Interfaz incompatible con modo monitor');
  assert.equal(result.color, 'red');
  assert.match(result.question, /enp2s0 no es una tarjeta wifi/);
  assert.match(result.suggestion, /Selecciona una tarjeta WiFi compatible/);
});

test('detecta modo no-wifi en cabecera de menú principal y adapta descripciones', () => {
  const result = screen([
    '*********************** Menú principal airgeddon v12.02 ***********************',
    'Interfaz enp2s0 seleccionada. Modo: (Non wifi adapter)',
    '',
    'Selecciona una opción del menú:',
    '---------',
    '0.  Salir del script',
    '1.  Selecciona otra interfaz de red',
    '2.  Poner la interfaz en modo monitor',
    '---------',
    '> ',
  ]);
  assert.equal(result.type, 'menu');
  assert.equal(result.ifaceStatus.isNonWifi, true);
  assert.match(result.desc, /enp2s0.*no es WiFi/i);
  const opt2 = result.items.find((it) => it.key === '2');
  assert.match(opt2.desc, /No compatible/);
});

test('el aviso multilínea de .airgeddonrc se muestra completo y sin duplicar', () => {
  const result = screen([
    ' Opciones e idioma',
    ' Continuar',
    '',
    ' Atención. Por favor revisa el fichero /home/usuario/airgeddon/.airgeddonrc.',
    ' No se ha encontrado la variable AIRGEDDON_WINDOWS_HANDLING.',
    ' El valor por defecto xterm será usado',
    '',
    ' Pulsa la tecla [Enter] para continuar...',
    '> ',
  ]);
  assert.equal(result.type, 'enter');
  // El aviso completo debe aparecer, no solo su última línea.
  assert.match(result.desc, /Atención\. Por favor revisa el fichero/);
  assert.match(result.desc, /AIRGEDDON_WINDOWS_HANDLING/);
  assert.match(result.desc, /valor por defecto xterm/);
  // El texto no debe repetirse dentro del mismo prompt.
  assert.equal(result.desc, result.question);
  // Y debe marcarse como texto propio para que la interfaz no lo duplique.
  assert.equal(result.isDefaultDesc, false);
});

test('sin mensaje previo usa el texto genérico y lo marca como tal', () => {
  const result = screen([
    ' Pulsa la tecla [Enter] para continuar...',
    '> ',
  ]);
  assert.equal(result.type, 'enter');
  assert.equal(result.isDefaultDesc, true);
  assert.match(result.desc, /esperando tu confirmación/);
});

test('resume los muchos avisos de variables ausentes en .airgeddonrc', () => {
  const vars = [
    'AIRGEDDON_5GHZ_ENABLED', 'AIRGEDDON_6GHZ_ENABLED', 'AIRGEDDON_AUTO_UPDATE',
    'AIRGEDDON_DEBUG_MODE', 'AIRGEDDON_PLUGINS_ENABLED', 'AIRGEDDON_PRINT_HINTS',
  ];
  const lines = [' Opciones e idioma', ' Continuar', ''];
  for (const v of vars) {
    lines.push(` Atención. Por favor revisa el fichero /home/usuario/airgeddon/.airgeddonrc. No se ha encontrado la variable ${v}. El valor por defecto true será usado`);
    lines.push('');
  }
  lines.push(' Pulsa la tecla [Enter] para continuar...');
  lines.push('> ');

  const result = screen(lines);
  assert.equal(result.type, 'enter');
  // Se resume en lugar de repetir cada aviso.
  assert.match(result.desc, /6 variables ausentes/);
  // No debe aparecer el menu previo.
  assert.doesNotMatch(result.desc, /Opciones e idioma/);
  // Y no debe duplicarse el texto.
  assert.equal(result.desc, result.question);
});

test('un solo aviso de variable ausente se muestra completo', () => {
  const result = screen([
    ' Atención. Por favor revisa el fichero /home/usuario/airgeddon/.airgeddonrc. No se ha encontrado la variable AIRGEDDON_WINDOWS_HANDLING. El valor por defecto xterm será usado',
    '',
    ' Pulsa la tecla [Enter] para continuar...',
    '> ',
  ]);
  assert.equal(result.type, 'enter');
  assert.match(result.desc, /AIRGEDDON_WINDOWS_HANDLING/);
  assert.match(result.desc, /valor por defecto xterm/);
  assert.equal(result.desc, result.question);
});

test('con la salida real de airgeddon resume los 18 avisos de .airgeddonrc', () => {
  // Salida real capturada de airgeddon v12.02: 18 avisos de variables
  // ausentes (tu .airgeddonrc solo define AIRGEDDON_LANGUAGE) y un único
  // "Pulsa Enter" al final.
  const vars = [
    'AIRGEDDON_5GHZ_ENABLED', 'AIRGEDDON_6GHZ_ENABLED', 'AIRGEDDON_AUTO_CHANGE_LANGUAGE',
    'AIRGEDDON_AUTO_UPDATE', 'AIRGEDDON_BASIC_COLORS', 'AIRGEDDON_DEBUG_MODE',
    'AIRGEDDON_DEVELOPMENT_MODE', 'AIRGEDDON_EVIL_TWIN_ESSID_STRIPPING',
    'AIRGEDDON_EVIL_TWIN_SOUNDS', 'AIRGEDDON_EXTENDED_COLORS', 'AIRGEDDON_FORCE_IPTABLES',
    'AIRGEDDON_FORCE_NETWORK_MANAGER_KILLING', 'AIRGEDDON_MDK_VERSION',
    'AIRGEDDON_PLUGINS_ENABLED', 'AIRGEDDON_PRINT_HINTS', 'AIRGEDDON_SILENT_CHECKS',
    'AIRGEDDON_SKIP_INTRO', 'AIRGEDDON_WINDOWS_HANDLING',
  ];
  const lines = [
    '********************************** Bienvenid@ **********************************',
    'Idioma Español del S.O. detectado. Soportado por el script. Se cambió automáticamente',
    '',
    'Tu distro tiene todas las herramientas esenciales necesarias. El script puede continuar...',
    'Pulsa la tecla [Enter] para continuar...',
    '',
  ];
  for (const v of vars) {
    lines.push(` Atención. Por favor revisa el fichero /home/usuario/airgeddon/.airgeddonrc. No se ha encontrado la variable ${v}. El valor por defecto true será usado`);
    lines.push('');
  }
  lines.push('Pulsa la tecla [Enter] para continuar...');
  lines.push('> ');

  const result = screen(lines);
  assert.equal(result.type, 'enter');
  // Resume en vez de repetir los 18 avisos.
  assert.match(result.desc, /18 variables ausentes/);
  assert.match(result.desc, /AIRGEDDON_5GHZ_ENABLED/);
  // No debe arrastrar el texto del arranque de airgeddon.
  assert.doesNotMatch(result.desc, /Bienvenid/);
  assert.doesNotMatch(result.desc, /Idioma Español/);
  // Y el texto no se duplica.
  assert.equal(result.desc, result.question);
});

test('la pantalla de bienvenida inicial de airgeddon se detecta con contexto inicio y mensaje conciso', () => {
  const result = screen([
    '********************************** Bienvenid@ **********************************',
    'Este script se ha hecho sólo con fines educativos. Sed buen@s chic@s!',
    'Utilízalo solo en tus propias redes!!',
    '',
    'Idioma Español del S.O. detectado. Soportado por el script. Se cambió automáticamente',
    'Versión de bash (5.3.20(1)-release) aceptada. Mínimo requerido versión: 4.2',
    'Permisos de root correctamente detectados',
    'Detectando resolución... Detectada!: 1920x1080',
    'Distros conocidas compatibles con este script:',
    '"Arch" "Backbox" "BlackArch" "CachyOS" "Debian" "Fedora" "Kali" "Ubuntu"',
    'Detectando sistema...',
    'CachyOS Linux',
    '',
    'Vamos a chequear si tienes instalado lo que el script requiere',
    'Pulsa la tecla [Enter] para continuar...',
    '> ',
  ]);
  assert.equal(result.type, 'enter');
  assert.equal(result.context.id, 'startup');
  assert.equal(result.context.name, 'Inicio de airgeddon');
  assert.equal(result.title, 'Comprobación de requisitos');
  assert.equal(result.question, 'Vamos a chequear si tienes instalado lo que el script requiere.');
  assert.equal(result.isStartup, true);
  assert.notEqual(result.title, 'Completado con éxito');
  assert.notEqual(result.context.name, 'Opciones e idioma');
});

test('la comprobación de herramientas no arrastra el banner de bienvenida del paso anterior', () => {
  const result = screen([
    '********************************** Bienvenid@ **********************************',
    'Vamos a chequear si tienes instalado lo que el script requiere',
    'Pulsa la tecla [Enter] para continuar...',
    '',
    'Herramientas esenciales: comprobando...',
    'iw .... Ok    awk .... Ok    airmon-ng .... Ok',
    '',
    'Tu distro tiene todas las herramientas esenciales necesarias. El script puede continuar...',
    'Pulsa la tecla [Enter] para continuar...',
    '> ',
  ]);
  assert.equal(result.type, 'enter');
  assert.equal(result.context.id, 'startup');
  assert.equal(result.title, 'Herramientas verificadas');
  assert.equal(result.question, 'Tu distro tiene todas las herramientas esenciales necesarias. El script puede continuar.');
  assert.equal(result.isStartup, true);
  assert.doesNotMatch(result.question, /Bienvenid/);
});
