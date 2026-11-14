#!/usr/bin/env bash
# ==============================================================================
# airgeddon GUI — Instalador de integración en el escritorio (Linux / CachyOS / KDE)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${HOME}/.local/share/applications"
PIXMAPS_DIR="${HOME}/.local/share/pixmaps"
HICOLOR_DIR="${HOME}/.local/share/icons/hicolor"

WAYLAND_ALIASES=(
    "brave-127.0.0.1__-Default.desktop"
    "brave-127.0.0.1_3845-Default.desktop"
    "brave-http___127.0.0.1_3845-Default.desktop"
    "brave-127.0.0.1-Default.desktop"
    "chrome-127.0.0.1__-Default.desktop"
    "chrome-127.0.0.1_3845-Default.desktop"
    "chrome-http___127.0.0.1_3845-Default.desktop"
    "chrome-127.0.0.1-Default.desktop"
    "brave-airgeddon-gui-Default.desktop"
    "chrome-airgeddon-gui-Default.desktop"
)

SIZES=(16 24 32 48 64 128 256)

if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ]; then
    echo "[*] Desinstalando acceso directo de airgeddon GUI..."
    rm -f "${APP_DIR}/airgeddon-gui.desktop"
    for alias in "${WAYLAND_ALIASES[@]}"; do
        rm -f "${APP_DIR}/${alias}"
    done
    for s in "${SIZES[@]}"; do
        rm -f "${HICOLOR_DIR}/${s}x${s}/apps/airgeddon-gui.png"
    done
    rm -f "${PIXMAPS_DIR}/airgeddon-gui.png"
    rm -f "${PIXMAPS_DIR}"/airgeddon-gui-*.png
    rm -f "${HOME}/.local/share/icons/airgeddon-gui.png"

    if command -v update-desktop-database &> /dev/null; then
        update-desktop-database "$APP_DIR" 2>/dev/null || true
    fi
    if command -v gtk-update-icon-cache &> /dev/null; then
        gtk-update-icon-cache -f -t "$HICOLOR_DIR" 2>/dev/null || true
    fi
    echo "[✓] Acceso directo desinstalado correctamente."
    exit 0
fi

echo "[*] Instalando airgeddon GUI en el menú de aplicaciones y barra de tareas..."

# 1. Asegurar directorios
mkdir -p "$APP_DIR" "$PIXMAPS_DIR" "${HOME}/.local/share/icons"
for s in "${SIZES[@]}"; do
    mkdir -p "${HICOLOR_DIR}/${s}x${s}/apps"
done

# 2. Generar iconos multirresolución con Python o herramientas del sistema
ICON_SOURCE=""
if [ -f "${SCRIPT_DIR}/public/img/app-icon.png" ]; then
    ICON_SOURCE="${SCRIPT_DIR}/public/img/app-icon.png"
elif [ -f "${SCRIPT_DIR}/public/img/airgeddon-logo-full.png" ]; then
    ICON_SOURCE="${SCRIPT_DIR}/public/img/airgeddon-logo-full.png"
fi

if [ -n "$ICON_SOURCE" ]; then
    python3 -c "
import os, sys
from PIL import Image

src = sys.argv[1]
home = os.path.expanduser('~')
sizes = [16, 24, 32, 48, 64, 128, 256]

try:
    im = Image.open(src).convert('RGBA')
    for s in sizes:
        d = os.path.join(home, f'.local/share/icons/hicolor/{s}x{s}/apps')
        os.makedirs(d, exist_ok=True)
        out_f = os.path.join(d, 'airgeddon-gui.png')
        resized = im.resize((s, s), Image.Resampling.LANCZOS)
        resized.save(out_f)

    pix_d = os.path.join(home, '.local/share/pixmaps')
    os.makedirs(pix_d, exist_ok=True)
    im.save(os.path.join(pix_d, 'airgeddon-gui.png'))
    im.save(os.path.join(home, '.local/share/icons/airgeddon-gui.png'))
except Exception as e:
    sys.exit(1)
" "$ICON_SOURCE" 2>/dev/null || {
        # Fallback si falla python
        for s in "${SIZES[@]}"; do
            cp "$ICON_SOURCE" "${HICOLOR_DIR}/${s}x${s}/apps/airgeddon-gui.png" 2>/dev/null || true
        done
        cp "$ICON_SOURCE" "${PIXMAPS_DIR}/airgeddon-gui.png" 2>/dev/null || true
        cp "$ICON_SOURCE" "${HOME}/.local/share/icons/airgeddon-gui.png" 2>/dev/null || true
    }
fi

# Ruta de contenido versionada: evita reutilizar el icono antiguo en la caché de KDE.
ICON_PATH="${PIXMAPS_DIR}/airgeddon-gui.png"
if [ -n "$ICON_SOURCE" ] && command -v sha256sum &> /dev/null; then
    ICON_CHECKSUM=$(sha256sum "$ICON_SOURCE")
    ICON_PATH="${PIXMAPS_DIR}/airgeddon-gui-${ICON_CHECKSUM:0:12}.png"
    cp "$ICON_SOURCE" "$ICON_PATH"
fi

# 3. Dar permisos de ejecución al script principal
chmod +x "${SCRIPT_DIR}/airgeddon-gui.sh" 2>/dev/null || true

# 4. Crear archivo .desktop principal
cat << EOF > "${APP_DIR}/airgeddon-gui.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=airgeddon GUI
GenericName=Auditoría de Redes WiFi
Comment=Herramienta de auditoría inalámbrica con interfaz gráfica nativa
Exec="${SCRIPT_DIR}/airgeddon-gui.sh"
Icon=${ICON_PATH}
Terminal=false
Categories=Network;Security;System;
StartupNotify=true
StartupWMClass=airgeddon-gui
Keywords=wifi;wireless;audit;security;airgeddon;redes;auditoria;wpa;wps;
X-KDE-Protocols=http
EOF

chmod +x "${APP_DIR}/airgeddon-gui.desktop" 2>/dev/null || true

# 5. Crear entradas auxiliares para Wayland (KWin / KDE Plasma)
# Brave y Chromium bajo Ozone Wayland generan app_id derivados de la URL/perfil.
# Estas entradas aseguran que KWin y el Administrador de Tareas de Plasma asocien
# la ventana de inmediato con el icono del alien amarillo en lugar del logo "W" genérico.
for alias in "${WAYLAND_ALIASES[@]}"; do
    cat << EOF > "${APP_DIR}/${alias}"
[Desktop Entry]
Version=1.0
Type=Application
Name=airgeddon GUI
GenericName=Auditoría de Redes WiFi
Comment=Herramienta de auditoría inalámbrica con interfaz gráfica nativa
Exec="${SCRIPT_DIR}/airgeddon-gui.sh"
Icon=${ICON_PATH}
Terminal=false
NoDisplay=true
StartupNotify=true
StartupWMClass=${alias%.desktop}
EOF
    chmod +x "${APP_DIR}/${alias}" 2>/dev/null || true
done

# 6. Actualizar cachés del sistema de escritorio
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database "$APP_DIR" 2>/dev/null || true
fi

if command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t "$HICOLOR_DIR" 2>/dev/null || true
fi

if command -v kbuildsycoca6 &> /dev/null; then
    kbuildsycoca6 --noincremental 2>/dev/null || true
elif command -v kbuildsycoca5 &> /dev/null; then
    kbuildsycoca5 --noincremental 2>/dev/null || true
fi

echo "[✓] ¡Integración en escritorio completada!"
echo "    airgeddon GUI y sus iconos han sido configurados correctamente."
