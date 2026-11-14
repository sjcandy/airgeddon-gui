# Maintainer: sjcandy <sjcandy@users.noreply.github.com>
# Contributor: airgeddon-gui contributors

pkgname=airgeddon-gui-git
pkgver=2.0.0.r1.g0000000
pkgrel=1
pkgdesc="Entorno gráfico nativo y suite de escritorio para airgeddon (auditoría inalámbrica)"
arch=('x86_64' 'aarch64')
url="https://github.com/sjcandy/airgeddon-gui"
license=('MIT')
depends=('nodejs>=22' 'npm' 'bash' 'sudo' 'iproute2' 'curl')
optdepends=(
  'brave-bin: Ventana de escritorio nativa sin marco de navegador'
  'chromium: Ventana de escritorio nativa'
  'google-chrome-stable: Ventana de escritorio nativa'
  'aircrack-ng: Suite de herramientas de auditoría inalámbrica (airmon-ng, airodump-ng, aireplay-ng)'
  'iw: Utilidades de configuración de interfaces inalámbricas'
  'wireless-tools: Utilidades inalámbricas adicionales'
  'ccze: Colorización de la salida de terminal'
  'xterm: Terminal complementaria para los procesos hijos de airgeddon'
  'mdk4: Ataques DoS de desautenticación masiva'
  'lighttpd: Servidor para el portal cautivo (Evil Twin)'
  'dnsmasq: Servidor DNS/DHCP para el portal cautivo (Evil Twin)'
)
makedepends=('git' 'node-gyp' 'python' 'make' 'gcc')
provides=('airgeddon-gui')
conflicts=('airgeddon-gui')

source=('git+https://github.com/sjcandy/airgeddon-gui.git')
sha256sums=('SKIP')

# El repositorio se extrae dentro de $srcdir con el nombre del repo.
# Este helper devuelve esa ruta y hace que build() y package() operen siempre
# sobre el mismo directorio, que no es necesariamente $srcdir.
_srcdir_real() {
  if [ -f "$srcdir/package.json" ] && [ -d "$srcdir/public" ]; then
    echo "$srcdir"
    return 0
  fi
  local d
  for d in "$srcdir"/*/; do
    if [ -f "$d/package.json" ] && [ -d "$d/public" ]; then
      echo "${d%/}"
      return 0
    fi
  done
  echo "$srcdir"
}

pkgver() {
  cd "$(_srcdir_real)"
  local tag
  tag=$(git describe --tags --abbrev=0 2>/dev/null || echo 2.0.0)
  printf '%s.r%s.g%s\n' \
    "$tag" \
    "$(git rev-list --count HEAD 2>/dev/null || echo 0)" \
    "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
}

build() {
  cd "$(_srcdir_real)"
  # node-pty es una dependencia nativa: se compila aquí para que el paquete
  # instalado incluya node_modules y no necesite permisos de escritura en /opt.
  npm ci --omit=dev
  # Reduce el tamaño del paquete: el código fuente de las dependencias no
  # hace falta en tiempo de ejecución.
  find node_modules -type d -name test -prune -exec rm -rf {} + 2>/dev/null || true
  find node_modules -type d -name '*.md' -delete 2>/dev/null || true

}

package() {
  cd "$(_srcdir_real)"

  install -d "${pkgdir}/opt/airgeddon-gui"
  install -d "${pkgdir}/usr/bin"
  install -d "${pkgdir}/usr/share/applications"
  install -d "${pkgdir}/usr/share/doc/${pkgname}"
  install -d "${pkgdir}/usr/share/icons/hicolor/256x256/apps"
  install -d "${pkgdir}/usr/share/icons/hicolor/48x48/apps"
  install -d "${pkgdir}/usr/share/pixmaps"

  # Archivos esenciales de la aplicación en /opt/airgeddon-gui
  install -Dm644 package.json "${pkgdir}/opt/airgeddon-gui/package.json"
  install -Dm644 package-lock.json "${pkgdir}/opt/airgeddon-gui/package-lock.json"
  install -Dm644 server.js "${pkgdir}/opt/airgeddon-gui/server.js"
  install -Dm755 airgeddon-gui.sh "${pkgdir}/opt/airgeddon-gui/airgeddon-gui.sh"
  # El lanzador invoca install-desktop.sh para registrar el acceso directo.
  install -Dm755 install-desktop.sh "${pkgdir}/opt/airgeddon-gui/install-desktop.sh"
  install -Dm644 system-requirements.txt "${pkgdir}/opt/airgeddon-gui/system-requirements.txt"
  install -Dm644 LICENSE "${pkgdir}/opt/airgeddon-gui/LICENSE"
  cp -a public "${pkgdir}/opt/airgeddon-gui/public"
  cp -a node_modules "${pkgdir}/opt/airgeddon-gui/node_modules"
  node scripts/prepare-package.js "${pkgdir}/opt/airgeddon-gui"

  # Documentación
  install -Dm644 README.md "${pkgdir}/usr/share/doc/${pkgname}/README.md"
  install -Dm644 CHANGELOG.md "${pkgdir}/usr/share/doc/${pkgname}/CHANGELOG.md"

  # Lanzador global en /usr/bin/airgeddon-gui
  cat << 'EOF' > "${pkgdir}/usr/bin/airgeddon-gui"
#!/bin/bash
cd /opt/airgeddon-gui
exec ./airgeddon-gui.sh "$@"
EOF
  chmod 755 "${pkgdir}/usr/bin/airgeddon-gui"

  # Acceso directo en el menú de aplicaciones
  cat << 'EOF' > "${pkgdir}/usr/share/applications/airgeddon-gui.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=airgeddon GUI
GenericName=Auditoría de Redes WiFi
Comment=Herramienta de auditoría inalámbrica con interfaz gráfica nativa
Exec=/usr/bin/airgeddon-gui
Icon=airgeddon-gui
Terminal=false
Categories=Network;Security;System;
StartupNotify=true
StartupWMClass=airgeddon-gui
Keywords=wifi;wireless;audit;security;airgeddon;redes;auditoria;wpa;wps;
EOF
  chmod 644 "${pkgdir}/usr/share/applications/airgeddon-gui.desktop"

  # Iconos de la aplicación
  if [ -f "public/img/app-icon.png" ]; then
    install -Dm644 public/img/app-icon.png "${pkgdir}/usr/share/icons/hicolor/256x256/apps/airgeddon-gui.png"
    install -Dm644 public/img/app-icon.png "${pkgdir}/usr/share/icons/hicolor/48x48/apps/airgeddon-gui.png"
    install -Dm644 public/img/app-icon.png "${pkgdir}/usr/share/pixmaps/airgeddon-gui.png"
  fi
}
