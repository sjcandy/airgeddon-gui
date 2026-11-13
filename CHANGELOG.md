# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto adhiere a [Semantic Versioning](https://semver.org/lang/es/).

## [2.0.0] - 2026-11-11

### Added
- Aplicación de escritorio nativa para Linux: integrador `.desktop`, iconos multirresolución (16–256 px),
  alias Wayland/KWin y lanzador `airgeddon-gui.sh` con apertura de ventana nativa de escritorio.
- Empaquetado nativo para **Debian / Ubuntu / Kali / Parrot** (`build-deb.sh` → `.deb`) y para
  **Arch / CachyOS / Manjaro** (`PKGBUILD` como paquete VCS).
- Instalador interactivo `install.sh` con detección del gestor de paquetes (`pacman` / `apt` / `dnf`),
  comprobación e instalación de Node.js, localización o clonado de airgeddon e instalación de las
  herramientas de auditoría complementarias.
- Sistema integrado de actualizaciones desde la interfaz (Comprobar / Actualizar ahora).
- Vista de **Auditorías** con 8 auditorías guiadas, guías modales, notas, progreso y plantillas.
- Vista de **Redes** con escaneo nativo en vivo (`airodump-ng` en CSV), asociación de clientes al AP,
  ordenación por señal/canal/seguridad/banda/clientes, filtros de banda y señal mínima, favoritos y
  exportación a CSV.
- Vista de **Diagnóstico** con detección de 31 herramientas de auditoría y estado de airgeddon, `sudo` y sistema.
- Consola PTY en vivo con xterm.js: búsqueda (`Ctrl+F`), copia de selección, tamaño de fuente ajustable,
  auto-scroll inteligente, 3 pestañas (airgeddon / Sistema / Eventos) y descarga del log de sesión.
- Modos de interacción **Asistente** y **Consola** conmutables, y acción de "Ver en consola" en cada modal.
- Perfil de navegador dedicado con gestor de contraseñas y notificaciones desactivados.
- `system-requirements.txt` con los comandos de instalación por distribución.
- Tests unitarios del parser con `node:test` (`npm test`).
- Documentación profesional: README con capturas, arquitectura, instalación por gestor de paquetes,
  CI con GitHub Actions y bloque de créditos con la atribución a airgeddon (GPLv3).

### Changed
- El escaneo de redes se delega en `airodump-ng` con salida CSV y actualización en vivo, en lugar de parsear la
  tabla ASCII de airgeddon.
- Se eliminan las sugerencias de teclas del pie de los modales y se alinean los botones a la derecha.
- Se elimina el footer de la aplicación y se amplía el modal de redes a 1000 px.
- `airgeddon` se ejecuta siempre con `bash` (no `zsh`) para evitar errores con arrays asociativos.
- El botón de tema se traslada exclusivamente a Configuración; la barra superior usa el color de acento.

### Security
- Forzado de escucha en loopback (`127.0.0.1` / `localhost`) para prevenir exposición accidental en redes públicas o externas.
- Protección de endpoints GET sensibles (`/api/captures`, `/api/config/raw`, `/api/diagnostics`, `/api/info`, `/api/system/updates`, `/api/interfaces`) exigiendo token de sesión para evitar fuga de información privada.
- Autenticación WebSocket mediante subprotocolo `Sec-WebSocket-Protocol` (`airgeddon-auth`), eliminando el paso de credenciales en la URL (query string).
- Límite de conexiones WebSocket simultáneas concurrentes para evitar ataques de denegación de servicio (DoS).
- Limitador de tasa (*rate limit*) de autenticación sudo segregado por IP de origen y temporizador de bloqueo automático por inactividad (15 min).
- Eliminación de `pkill` indiscriminados sobre servicios de red en `/api/interfaces/kill`, limitándose a la ejecución canónica de `airmon-ng check kill`.
- Eliminación de descarga y ejecución remota de scripts (`curl | sudo bash`) en `install.sh`, utilizando paquetes oficiales de la distribución.
- Token de sesión criptográfico efímero generado al arrancar, exigido en handshake WebSocket y peticiones REST mutadoras (`X-CSRF-Token`).
- Rechazo estricto de `Origin: null` para mitigar ataques CSRF/CSWSH desde `iframe` sandboxed o URIs `data:`.
- Retardo defensivo de 500 ms en `/api/auth` contra análisis de tiempos y fuerza bruta.
- Aislamiento en la terminación de procesos: señalización restringida al árbol de procesos hijo (`pkill -P`), evitando afectar procesos ajenos del sistema.
- Sanitización en el buscador rápido: escape estricto de nombres de redes (SSID) y etiquetas contra inyección HTML/XSS.
- Restauración selectiva de interfaces inalámbricas en `beforeunload`, limitándose únicamente a las interfaces puestas en modo monitor por esta GUI.
- Validación del resultado de `npm install` en el actualizador (`/api/system/updates/apply`) para no reportar éxito si falla la instalación de paquetes.
- Sincronización de versiones de metadatos entre `package.json` y `package-lock.json` (v2.0.0).

### Fixed
- `sudo: zsh --login: command not found` — se usa la ruta completa y se separan los argumentos de `sudo`.
- `airgeddon.sh:99 error de arrays asociativos` — se ejecuta con `bash`.
- Falsos positivos del parser con "Volver al menú principal".
- Potencia dBm negativa convertida a porcentaje de señal.
- Modal que creaba un footer vacío antes de montarse.
- Validación de contraseña `sudo` caducada y carreras de arranque/cierre de `airodump-ng`.
- Bucle infinito de confirmación con `Enter` durante el escaneo de redes.
- La ruta del directorio de escritorio ya no está hardcodeada a `Escritorio`: se resuelve con `xdg-user-dir`.
- El paquete de Arch ahora compila e instala `node_modules`, incluye `install-desktop.sh` y declara `iproute2`;
  antes el paquete instalado no arrancaba por falta de `node-pty`.
- El paquete `.deb` compila las dependencias en el momento de la compilación en lugar de descargarlas durante la
  instalación, y añade un `prerm` que detiene la aplicación antes de desinstalar.
- El workflow de releases construye el paquete `.deb` antes de publicarlo; antes la release salía sin adjuntos.
- Se eliminan las definiciones duplicadas de `maximize()`, `isMaximized()` y `copySelection()` en la terminal.
- Se corrigen las tildes ausentes en los mensajes de la interfaz ("Seleccion copiada", "La sesion termino con
  codigo").
- Se elimina `i18n.js`: el diccionario no lo usaba ninguna parte de la aplicación.
- El modal de "Continuar" ya no repite el mensaje: el texto se mostraba dos veces, como subtítulo de la cabecera y
  otra vez dentro del cuerpo.
- Los avisos multilínea de airgeddon (por ejemplo, la advertencia de una variable ausente en `.airgeddonrc`) se
  muestran completos en lugar de solo su última línea.
- Los avisos repetidos de variables ausentes en `.airgeddonrc` se resumen en un solo mensaje
  ("airgeddon avisó de 18 variables ausentes...") en lugar de apilar los 18 avisos en el modal.
- Se restaura `.airgeddonrc` con sus 18 variables de configuración completas, eliminando los avisos en el arranque.
- Se añade el contexto `startup` (`Inicio de airgeddon`) para que la pantalla de bienvenida y verificación de herramientas no se clasifique erróneamente como "Opciones e idioma" ni "Completado con éxito".
- El parser aísla cada paso de confirmación ("Pulsa Enter"), evitando que la segunda confirmación de herramientas arrastre el texto y banner del paso previo.
- **Auto-avance de confirmaciones iniciales**: confirmar el primer paso de comprobación inicial avanza automáticamente los pasos siguientes de verificación sin requerir pulsar Enter repetidamente.
- El bloque de texto previo al prompt ya no se corta en las líneas vacías, que son las que airgeddon usa para
  separar sus avisos.
- Se corrige el cierre prematuro del servidor en `airgeddon-gui.sh` provocado por la finalización rápida del proceso lanzador del navegador (como wrappers o instancias existentes).
- Se añade comprobación de ejecución real (`can_run_browser`) para evitar falsos positivos con wrappers rotos en el sistema.
- Se incorporan opciones de línea de comandos en `airgeddon-gui.sh`: `--help` (`-h`), `--browser` (`-b`) y `--server-only` (`-s`).

### Security
- La contraseña de `sudo` solo reside en la memoria RAM del proceso, se enmascara en la salida y se invalida con
  `POST /api/lock`.
- Content-Security-Policy estricta (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`).
- Los nombres de interfaz se validan contra `^[a-zA-Z0-9_.:-]+$` antes de usarse en comandos.
- El servidor hace bind exclusivo a `127.0.0.1`.
- Se desactivan el autoguardado de contraseñas y los avisos de notificaciones del navegador en modo aplicación.
- **Protección CSRF**: las peticiones que modifican el estado se rechazan cuando el encabezado `Origin` no
  corresponde al propio servidor, de modo que una página web ajena no puede invocar la API local.
- **Protección CSWSH (Cross-Site WebSocket Hijacking)**: validación del encabezado `Origin` en el handshake de WebSocket `/ws`, rechazando conexiones ajenas al servidor local.
- Ocultación exhaustiva de tokens y credenciales en URLs de remotos git en logs y respuestas de la API (`https://<token>@...` y `https://user:<token>@...`).

## [1.0.0] - 2026-11-09

### Added
- GUI completa para airgeddon con panel, auditorías, redes, interfaces, historial, configuración y diagnóstico
- Asistente interactivo que detecta menús, redes, confirmaciones, texto y contraseñas
- Consola en vivo con xterm.js
- Escaneo nativo con airodump-ng
- Gestión de interfaces con airmon-ng
- Editor de .airgeddonrc
- Diagnóstico del sistema
- Tema claro/oscuro
- Diseño responsive (escritorio y móvil)
- Parser de pantalla con 8/8 tests passing
- Integración con Firefox (geckodriver) 40/40 tests
- E2E con airgeddon simulado 31/31 tests
- Auditoría de layout 19/19 tests
