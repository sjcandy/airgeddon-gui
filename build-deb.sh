#!/usr/bin/env bash
# ==============================================================================
# airgeddon-gui — Creador de paquete nativo Debian / Kali / Ubuntu (.deb)
# ==============================================================================
# Permite generar un archivo .deb instalable con:
#   sudo dpkg -i airgeddon-gui_2.0.0_all.deb
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="airgeddon-gui"
PKG_VER="2.0.0"
PKG_ARCH="all"
BUILD_ROOT="${SCRIPT_DIR}/build-deb"
PKG_DIR="${BUILD_ROOT}/${PKG_NAME}_${PKG_VER}_${PKG_ARCH}"

if ! command -v dpkg-deb &> /dev/null; then
    echo "[!] Error: 'dpkg-deb' no está instalado en este sistema."
    echo "    En Debian/Kali/Ubuntu/Parrot: sudo apt install -y dpkg"
    echo "    En Arch/CachyOS: sudo pacman -S dpkg"
    exit 1
fi

echo "[*] Generando paquete .deb para Debian / Kali Linux / Ubuntu..."

# 0. Compilar las dependencias de Node (node-pty es nativa).
# Se compila aquí para que el paquete instalado no necesite red ni permisos
# de escritura en /opt durante la instalación.
if [ ! -d "${SCRIPT_DIR}/node_modules" ] || [ "${SKIP_NPM:-0}" != "1" ]; then
    echo "[*] Compilando dependencias de Node.js..."
    (cd "${SCRIPT_DIR}" && npm ci --omit=dev) || {
        echo "[!] Error: falló 'npm ci'. Revisa que tengas Node.js >= 18 y las"
        echo "    herramientas de compilación (build-essential, python3)."
        exit 1
    }
fi

rm -rf "$BUILD_ROOT"
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/opt/airgeddon-gui"
mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/applications"
mkdir -p "${PKG_DIR}/usr/share/doc/${PKG_NAME}"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/256x256/apps"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/48x48/apps"
mkdir -p "${PKG_DIR}/usr/share/pixmaps"

# 1. Fichero de control Debian
cat << EOF > "${PKG_DIR}/DEBIAN/control"
Package: ${PKG_NAME}
Version: ${PKG_VER}
Section: net
Priority: optional
Architecture: ${PKG_ARCH}
Depends: nodejs (>= 18.0.0), npm, bash, sudo, iproute2
Recommends: aircrack-ng, xterm, curl, iw, ccze, wireless-tools, chromium | brave-browser | google-chrome-stable
Suggests: python3-pil, mdk4, lighttpd, dnsmasq
Homepage: https://github.com/sjcandy/airgeddon-gui
Maintainer: sjcandy <sjcandy@users.noreply.github.com>
Description: Interfaz gráfica y aplicación de escritorio para airgeddon
 Entorno visual moderno y asistido para auditorías de redes inalámbricas
 con soporte de ventana nativa de escritorio y consola PTY en vivo.
 .
 airgeddon-gui es un front-end independiente para airgeddon, obra de
 v1s1t0r1sh3r3 (https://github.com/v1s1t0r1sh3r3/airgeddon, GPLv3).
 airgeddon no se distribuye con este paquete y debe instalarse aparte.
EOF

# 2. Copiar archivos del programa
cp -a "${SCRIPT_DIR}/package.json" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/package-lock.json" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/server.js" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/airgeddon-gui.sh" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/install-desktop.sh" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/system-requirements.txt" "${PKG_DIR}/opt/airgeddon-gui/"

# Licencia y atribución (requisito de Debian: el copyright debe ser visible)
cp -a "${SCRIPT_DIR}/LICENSE" "${PKG_DIR}/usr/share/doc/${PKG_NAME}/copyright"
cp -a "${SCRIPT_DIR}/README.md" "${PKG_DIR}/usr/share/doc/${PKG_NAME}/README.md"
cp -a "${SCRIPT_DIR}/CHANGELOG.md" "${PKG_DIR}/usr/share/doc/${PKG_NAME}/CHANGELOG.md"

gzip -9nc "${SCRIPT_DIR}/CHANGELOG.md" > "${PKG_DIR}/usr/share/doc/${PKG_NAME}/changelog.Debian.gz"
cat << EOF > "${PKG_DIR}/usr/share/doc/${PKG_NAME}/changelog"
airgeddon-gui (${PKG_VER}) unstable; urgency=medium

  * Empaquetado inicial de airgeddon-gui como paquete nativo para Debian,
    Ubuntu, Kali Linux y Parrot OS.

 -- sjcandy <sjcandy@users.noreply.github.com>  $(date -R -d "@$(git -C "$SCRIPT_DIR" log -1 --format=%ct 2>/dev/null || echo 0)" 2>/dev/null || date -R)
EOF

cp -a "${SCRIPT_DIR}/public" "${PKG_DIR}/opt/airgeddon-gui/"
cp -a "${SCRIPT_DIR}/node_modules" "${PKG_DIR}/opt/airgeddon-gui/"

# 3. Lanzador global /usr/bin/airgeddon-gui
cat << 'EOF' > "${PKG_DIR}/usr/bin/airgeddon-gui"
#!/bin/bash
cd /opt/airgeddon-gui
exec ./airgeddon-gui.sh "$@"
EOF
chmod 755 "${PKG_DIR}/usr/bin/airgeddon-gui"

# 4. Acceso directo .desktop
cat << 'EOF' > "${PKG_DIR}/usr/share/applications/airgeddon-gui.desktop"
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
chmod 644 "${PKG_DIR}/usr/share/applications/airgeddon-gui.desktop"

# 5. Iconos
if [ -f "${SCRIPT_DIR}/public/img/app-icon.png" ]; then
    cp "${SCRIPT_DIR}/public/img/app-icon.png" "${PKG_DIR}/usr/share/icons/hicolor/256x256/apps/airgeddon-gui.png"
    cp "${SCRIPT_DIR}/public/img/app-icon.png" "${PKG_DIR}/usr/share/icons/hicolor/48x48/apps/airgeddon-gui.png"
    cp "${SCRIPT_DIR}/public/img/app-icon.png" "${PKG_DIR}/usr/share/pixmaps/airgeddon-gui.png"
fi

# 6. Post-instalación (postinst)
cat << 'EOF' > "${PKG_DIR}/DEBIAN/postinst"
#!/bin/bash
set -e
chmod +x /opt/airgeddon-gui/airgeddon-gui.sh
chmod +x /opt/airgeddon-gui/install-desktop.sh
chmod +x /usr/bin/airgeddon-gui
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi
exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# 7. Desinstalación (prerm)
cat << 'EOF' > "${PKG_DIR}/DEBIAN/prerm"
#!/bin/bash
# Detiene la aplicación si estuviera en ejecución antes de desinstalar.
pkill -f "/opt/airgeddon-gui/server.js" 2>/dev/null || true
exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/prerm"

# 8. Compilación con dpkg-deb
dpkg-deb --build "$PKG_DIR" "${SCRIPT_DIR}/${PKG_NAME}_${PKG_VER}_${PKG_ARCH}.deb"
rm -rf "$BUILD_ROOT"

echo "[✓] Paquete Debian creado: ${SCRIPT_DIR}/${PKG_NAME}_${PKG_VER}_${PKG_ARCH}.deb"
echo "    Para instalarlo en Debian/Kali/Ubuntu ejecuta:"
echo "    sudo apt install ./${PKG_NAME}_${PKG_VER}_${PKG_ARCH}.deb"
