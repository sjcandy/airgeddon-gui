#!/usr/bin/env bash
# ==============================================================================
# airgeddon-gui — Script de inicio rápido
# ==============================================================================
# Este script comprueba dependencias (Node.js, npm, airgeddon), instala los
# paquetes necesarios en la primera ejecución, levanta el servidor y abre la
# aplicación en una ventana nativa de escritorio o en el navegador.
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

USE_BROWSER_MODE=0
SERVER_ONLY=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help)
            echo -e "${CYAN}${BOLD}airgeddon GUI — Interfaz gráfica para airgeddon${NC}"
            echo ""
            echo "Uso: ./airgeddon-gui.sh [OPCIONES]"
            echo ""
            echo "Opciones:"
            echo "  -h, --help           Muestra esta ayuda y sale"
            echo "  -a, --app            Abre la interfaz en ventana de escritorio nativa (por defecto)"
            echo "  -b, --browser        Abre la interfaz en el navegador web estándar"
            echo "  -s, --server-only    Inicia solo el servidor web (modo sin ventana)"
            echo "  -p, --port PUERTO    Puerto del servidor (por defecto: 3845)"
            echo "  --host HOST          Host del servidor (por defecto: 127.0.0.1)"
            exit 0
            ;;
        -a|--app)
            USE_BROWSER_MODE=0
            shift
            ;;
        -b|--browser)
            USE_BROWSER_MODE=1
            shift
            ;;
        -s|--server-only|--no-browser)
            SERVER_ONLY=1
            shift
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        --host)
            HOST="$2"
            shift 2
            ;;
        %*|http://*|https://*)
            # Parámetros pasados por entornos de escritorio freedesktop (%u, %U, URLs)
            shift
            ;;
        *)
            echo -e "${RED}[✗] Opción no reconocida: $1${NC}"
            echo -e "    Usa ${BOLD}./airgeddon-gui.sh --help${NC} para ver las opciones disponibles."
            exit 1
            ;;
    esac
done

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
if [ "$NODE_VER" -lt 22 ]; then
    echo -e "${RED}[✗] Error: Se requiere Node.js >= 22 (versión detectada: $(node -v) está fuera de soporte).${NC}"
    echo -e "    Por favor actualiza a Node.js 24 LTS (recomendado)."
    exit 1
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

# 5. Comprobar sesión gráfica
if [ "$SERVER_ONLY" -eq 0 ] && [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
    echo -e "${YELLOW}[!] No se detectó un entorno gráfico (DISPLAY / WAYLAND_DISPLAY).${NC}"
    echo -e "    Iniciando automáticamente en modo servidor (${BOLD}--server-only${NC})."
    SERVER_ONLY=1
fi

# 6. Comprobar si el puerto ya está en uso
PORT_BUSY=""
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

# 7. Iniciar el servidor Node en segundo plano si no estaba activo
SERVER_PID=""
if [ "$ALREADY_RUNNING" -eq 0 ]; then
    PORT="$PORT" HOST="$HOST" node server.js &
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

# Función auxiliar para comprobar si un navegador es ejecutable
can_run_browser() {
    local b="$1"
    command -v "$b" &> /dev/null || return 1
    "$b" --version &> /dev/null || return 1
    return 0
}

# 8. Abrir interfaz en ventana de escritorio o navegador
APP_PID=""
if [ "$SERVER_ONLY" -eq 0 ]; then
    if [ "$USE_BROWSER_MODE" -eq 1 ]; then
        echo -e "${CYAN}[*] Abriendo en navegador web estándar...${NC}"
        if command -v xdg-open &> /dev/null; then
            xdg-open "$URL" &> /dev/null &
        elif can_run_browser firefox; then
            firefox --new-window "$URL" &> /dev/null &
            APP_PID=$!
        fi
    else
        # Asegurar integración de escritorio e iconos si no existen
        if [ ! -f "${HOME}/.local/share/applications/airgeddon-gui.desktop" ]; then
            bash "${SCRIPT_DIR}/install-desktop.sh" &> /dev/null || true
        fi

        # Perfil para la ventana de escritorio
        APP_PROFILE="${HOME}/.config/airgeddon-gui/app-profile"
        mkdir -p "${APP_PROFILE}/Default"

        # Desactivar gestor de contraseñas y notificaciones en el perfil de Chromium
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
        for b in brave-browser brave google-chrome-stable google-chrome chromium chromium-browser microsoft-edge; do
            if can_run_browser "$b"; then
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
                CANDIDATE_PID=$!
                sleep 0.3
                if kill -0 "$CANDIDATE_PID" 2>/dev/null; then
                    APP_PID="$CANDIDATE_PID"
                    APP_LAUNCHED=1
                    break
                fi
            fi
        done

        if [ "$APP_LAUNCHED" -eq 0 ]; then
            if can_run_browser firefox; then
                echo -e "${YELLOW}[*] Abriendo ventana con Firefox...${NC}"
                firefox --new-window "$URL" &> /dev/null &
                APP_PID=$!
            elif command -v xdg-open &> /dev/null; then
                echo -e "${CYAN}[*] Abriendo con navegador del sistema (xdg-open)...${NC}"
                xdg-open "$URL" &> /dev/null &
            else
                echo -e "${YELLOW}[!] No se detectó navegador automático.${NC}"
            fi
        fi
    fi
fi

# 9. Esperar mientras la aplicación o el servidor estén activos
echo -e "${CYAN}    ✦ airgeddon GUI en ejecución en ${URL}${NC}"
echo -e "${CYAN}    Presiona Ctrl+C en esta terminal cuando desees terminar.${NC}\n"

if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    # La ventana nativa sigue abierta y en ejecución; esperar hasta que el usuario la cierre
    wait "$APP_PID" 2>/dev/null || true
    cleanup
elif [ -n "$SERVER_PID" ]; then
    # Modo navegador o ventana delegada a proceso existente; mantener vivo el servidor
    wait "$SERVER_PID" 2>/dev/null || true
fi
