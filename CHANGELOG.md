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

### Fixed
- `sudo: zsh --login: command not found` — se usa la ruta completa y se separan los argumentos de `sudo`.
- `airgeddon.sh:99 error de arrays asociativos` — se ejecuta con `bash`.
- Falsos positivos del parser con "Volver al menú principal".
- Potencia dBm negativa convertida a porcentaje de señal.
- Modal que creaba un footer vacío antes de montarse.
- Validación de contraseña `sudo` caducada y carreras de arranque/cierre de `airodump-ng`.
- Bucle infinito de confirmación con `Enter` durante el escaneo de redes.
- La ruta del directorio de escritorio ya no está hardcodeada a `Escritorio`: se resuelve con `xdg-user-dir`.

### Security
- La contraseña de `sudo` solo reside en la memoria RAM del proceso, se enmascara en la salida y se invalida con
  `POST /api/lock`.
- Content-Security-Policy estricta (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`).
- Los nombres de interfaz se validan contra `^[a-zA-Z0-9_.:-]+$` antes de usarse en comandos.
- El servidor hace bind exclusivo a `127.0.0.1`.
- Se desactivan el autoguardado de contraseñas y los avisos de notificaciones del navegador en modo aplicación.

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
