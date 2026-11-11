#!/usr/bin/env bash
# ==============================================================================
# airgeddon-gui — Script de inicio rápido
# ==============================================================================
# Este script comprueba dependencias (Node.js, npm, airgeddon), instala los
# paquetes necesarios en la primera ejecución, levanta el servidor y abre
# automáticamente la interfaz en el navegador web.
# ==============================================================================

set -e

# Colores para la terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # Sin color

PORT="${PORT:-3845}"
HOST="${HOST:-127.0.0.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}${BOLD}"
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║                  airgeddon GUI                         ║"
echo "  ║           Interfaz Gráfica para airgeddon              ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# 1. Comprobar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}[✗] Error: Node.js no está instalado.${NC}"
    echo -e "    Por favor instálalo con tu gestor de paquetes:"
    echo -e "    ${YELLOW}sudo apt update && sudo apt install -y nodejs npm${NC} (Debian/Ubuntu/Kali)"
    echo -e "    ${YELLOW}sudo pacman -S nodejs npm${NC} (Arch Linux)"
    exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo -e "${YELLOW}[!] Advertencia: Se recomienda Node.js >= 18. Versión detectada: $(node -v)${NC}"
fi

# 2. Comprobar npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}[✗] Error: npm no está instalado.${NC}"
    echo -e "    Instálalo con: ${YELLOW}sudo apt install -y npm${NC}"
    exit 1
fi

# 3. Comprobar e instalar dependencias (node_modules)
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[*] Primera ejecución detectada: Instalando dependencias con npm...${NC}"
    if ! npm install; then
        echo -e "${RED}[✗] Falló la instalación de dependencias.${NC}"
        echo -e "    Si falló node-pty, instala las herramientas de compilación:"
        echo -e "    ${YELLOW}sudo apt install -y build-essential python3 make g++ libssl-dev${NC}"
        exit 1
    fi
    echo -e "${GREEN}[✓] Dependencias instaladas correctamente.${NC}\n"
fi

# 4. Localizar airgeddon
if [ -z "$AIRGEDDON_DIR" ]; then
    if [ -f "$SCRIPT_DIR/../airgeddon/airgeddon.sh" ]; then
        AIRGEDDON_DIR="$(cd "$SCRIPT_DIR/../airgeddon" && pwd)"
        export AIRGEDDON_DIR
    elif [ -f "/usr/share/airgeddon/airgeddon.sh" ]; then
        export AIRGEDDON_DIR="/usr/share/airgeddon"
    elif [ -f "$SCRIPT_DIR/airgeddon/airgeddon.sh" ]; then
        export AIRGEDDON_DIR="$SCRIPT_DIR/airgeddon"
    elif [ -f "$HOME/airgeddon/airgeddon.sh" ]; then
        export AIRGEDDON_DIR="$HOME/airgeddon"
    fi
fi

if [ -z "$AIRGEDDON_DIR" ] || [ ! -f "$AIRGEDDON_DIR/airgeddon.sh" ]; then
    echo -e "${YELLOW}[!] No se encontró airgeddon instalado en rutas habituales.${NC}"
    read -r -p "    ¿Deseas clonar airgeddon automáticamente en la carpeta superior? (s/n): " RESP
    if [[ "$RESP" =~ ^[sSyY]$ ]]; then
        echo -e "${BLUE}[*] Clonando airgeddon desde GitHub...${NC}"
        git clone https://github.com/v1s1t0r1sh3r3/airgeddon.git "$SCRIPT_DIR/../airgeddon"
        AIRGEDDON_DIR="$(cd "$SCRIPT_DIR/../airgeddon" && pwd)"
        export AIRGEDDON_DIR
        echo -e "${GREEN}[✓] airgeddon clonado en $AIRGEDDON_DIR${NC}\n"
    else
        echo -e "${YELLOW}[!] Puedes indicar la ruta manualmente antes de ejecutar:${NC}"
        echo -e "    ${BOLD}export AIRGEDDON_DIR=/ruta/a/airgeddon${NC}\n"
    fi
else
    echo -e "${GREEN}[✓] airgeddon detectado en:${NC} $AIRGEDDON_DIR"
fi

# 5. Comprobar si el puerto ya está en uso
if command -v lsof &> /dev/null; then
    PORT_BUSY=$(lsof -i ":$PORT" -t 2>/dev/null || true)
elif command -v fuser &> /dev/null; then
    PORT_BUSY=$(fuser "$PORT/tcp" 2>/dev/null || true)
fi

if [ -n "$PORT_BUSY" ]; then
    echo -e "${YELLOW}[!] El puerto $PORT ya está en uso por el proceso $PORT_BUSY.${NC}"
    read -r -p "    ¿Deseas cerrar el proceso anterior y continuar? (s/n): " KILL_RESP
    if [[ "$KILL_RESP" =~ ^[sSyY]$ ]]; then
        if command -v fuser &> /dev/null; then
            fuser -k "$PORT/tcp" &> /dev/null || true
        else
            kill -9 "$PORT_BUSY" &> /dev/null || true
        fi
        sleep 1
    else
        echo -e "${RED}[✗] Cancelado por el usuario.${NC}"
        exit 1
    fi
fi

URL="http://${HOST}:${PORT}"
echo -e "\n${GREEN}${BOLD}[*] Comprobando servidor en ${URL}...${NC}"

ALREADY_RUNNING=0
if command -v curl &> /dev/null; then
    if curl -s "http://${HOST}:${PORT}/api/health" &> /dev/null; then
        ALREADY_RUNNING=1
        echo -e "${GREEN}[✓] El servidor ya se encontraba en ejecución.${NC}"
    fi
fi

# Manejar salida limpia con Ctrl+C o al cerrar la ventana
cleanup() {
    echo -e "\n${YELLOW}[*] Cerrando airgeddon GUI...${NC}"
    if [ "$ALREADY_RUNNING" -eq 0 ] && [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    echo -e "${GREEN}[✓] Sesión finalizada.${NC}"
    exit 0
}
trap cleanup SIGINT SIGTERM

# 6. Iniciar el servidor Node en segundo plano si no estaba activo
if [ "$ALREADY_RUNNING" -eq 0 ]; then
    node server.js &
    SERVER_PID=$!

    # Esperar a que el servidor esté listo
    for _ in $(seq 1 20); do
        if command -v curl &> /dev/null; then
            if curl -s "http://${HOST}:${PORT}/api/health" &> /dev/null; then
                break
            fi
        else
            sleep 0.5
            break
        fi
        sleep 0.3
    done
    echo -e "${GREEN}${BOLD}[✓] Servidor listo.${NC}"
fi

# 7. Abrir ventana de aplicación nativa (modo standalone) o navegador
APP_PID=""
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    USE_BROWSER_MODE=0
    for arg in "$@"; do
        if [ "$arg" = "--browser" ] || [ "$arg" = "-b" ]; then
            USE_BROWSER_MODE=1
        fi
    done

    if [ "$USE_BROWSER_MODE" -eq 0 ]; then
        # Asegurar integración de escritorio e iconos si no existen
        if [ ! -f "${HOME}/.local/share/applications/airgeddon-gui.desktop" ] || [ ! -f "${HOME}/.local/share/applications/brave-127.0.0.1__-Default.desktop" ]; then
            bash "${SCRIPT_DIR}/install-desktop.sh" &> /dev/null || true
        fi

        # Modo aplicación nativa: ventana independiente sin barras de navegador
        APP_PROFILE="${HOME}/.config/airgeddon-gui/app-profile"
        mkdir -p "${APP_PROFILE}/Default"

        # Desactivar gestor de contraseñas y avisos emergentes de notificaciones en el perfil
        node -e '
          const fs = require("fs");
          const p = process.argv[1] + "/Default/Preferences";
          let prefs = {};
          try { prefs = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
          prefs.credentials_enable_service = false;
          prefs.profile = prefs.profile || {};
          prefs.profile.password_manager_enabled = false;
          prefs.profile.default_content_setting_values = prefs.profile.default_content_setting_values || {};
          prefs.profile.default_content_setting_values.notifications = 2;
          try { fs.writeFileSync(p, JSON.stringify(prefs, null, 2)); } catch {}
        ' "$APP_PROFILE" 2>/dev/null || true

        APP_LAUNCHED=0
        for b in brave brave-browser google-chrome-stable google-chrome chromium chromium-browser microsoft-edge; do
            if command -v "$b" &> /dev/null; then
                echo -e "${GREEN}[*] Abriendo ventana nativa de airgeddon GUI (${b})...${NC}"
                "$b" --app="$URL" \
                     --class="airgeddon-gui" \
                     --name="airgeddon-gui" \
                     --user-data-dir="$APP_PROFILE" \
                     --window-size=1280,820 \
                     --disable-save-password-bubble \
                     --disable-notifications \
                     --deny-permission-prompts \
                     --disable-features=PasswordManager,AutofillServerCommunication,Translate,OptimizationHints \
                     --password-store=basic \
                     --no-default-browser-check \
                     --no-first-run \
                     &> /dev/null &
                APP_PID=$!
                APP_LAUNCHED=1
                break
            fi
        done

        if [ "$APP_LAUNCHED" -eq 0 ]; then
            if command -v firefox &> /dev/null; then
                echo -e "${YELLOW}[*] Abriendo ventana con Firefox...${NC}"
                firefox --new-window "$URL" &> /dev/null &
                APP_PID=$!
            elif command -v xdg-open &> /dev/null; then
                xdg-open "$URL" &> /dev/null &
            fi
        fi
    else
        echo -e "${CYAN}[*] Abriendo en navegador web estándar...${NC}"
        if command -v xdg-open &> /dev/null; then
            xdg-open "$URL" &> /dev/null &
        fi
    fi
fi

# 8. Si la ventana de la aplicación está abierta, esperar a que el usuario la cierre
if [ -n "$APP_PID" ]; then
    wait "$APP_PID" 2>/dev/null || true
    cleanup
elif [ -n "$SERVER_PID" ]; then
    echo -e "${CYAN}    Presiona Ctrl+C en esta terminal cuando desees terminar.${NC}\n"
    wait "$SERVER_PID"
fi
