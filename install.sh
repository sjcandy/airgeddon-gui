#!/usr/bin/env bash
# ==============================================================================
# airgeddon-gui — Script de Instalación Automatizado
# ==============================================================================
# Configura el entorno completo para un usuario nuevo:
# 1. Comprueba / instala Node.js (>=18) y npm.
# 2. Pregunta si ya tiene airgeddon instalado; si no, lo clona automáticamente.
# 3. Ofrece instalar las herramientas complementarias de auditoría (aircrack-ng, etc.)
# 4. Instala dependencias del proyecto con npm.
# 5. Registra la aplicación en el menú de escritorio del sistema (.desktop e iconos).
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

clear 2>/dev/null || true

echo -e "${CYAN}${BOLD}"
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║                  airgeddon GUI                         ║"
echo "  ║         Instalador de Entorno de Escritorio            ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# 1. Detectar gestor de paquetes
PKG_MANAGER=""
if command -v pacman &> /dev/null; then
    PKG_MANAGER="pacman"
elif command -v apt-get &> /dev/null; then
    PKG_MANAGER="apt"
elif command -v dnf &> /dev/null; then
    PKG_MANAGER="dnf"
fi

echo -e "${BLUE}[*] Comprobando dependencias del sistema...${NC}"

# 2. Comprobar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[!] Node.js no está instalado.${NC}"
    read -r -p "    ¿Deseas instalar Node.js y npm automáticamente ahora? (s/n): " INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[sSyY]$ ]]; then
        if [ "$PKG_MANAGER" = "pacman" ]; then
            sudo pacman -S --needed nodejs npm
        elif [ "$PKG_MANAGER" = "apt" ]; then
            echo -e "${BLUE}[*] Instalando Node.js, npm y herramientas de compilación desde repositorios oficiales...${NC}"
            sudo apt update && sudo apt install -y nodejs npm build-essential
        elif [ "$PKG_MANAGER" = "dnf" ]; then
            sudo dnf install -y nodejs npm
        else
            echo -e "${RED}[✗] Gestor de paquetes no soportado para instalación automática.${NC}"
            echo -e "    Instala Node.js >= 18 manualmente y vuelve a ejecutar este instalador."
            exit 1
        fi
    else
        echo -e "${RED}[✗] Se requiere Node.js >= 18 para ejecutar airgeddon GUI.${NC}"
        exit 1
    fi
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
echo -e "${GREEN}[✓] Node.js detectado:${NC} $(node -v)"
if [ "$NODE_VER" -lt 18 ]; then
    echo -e "${YELLOW}[!] Advertencia: Tu versión de Node.js ($(node -v)) es inferior a la v18 recomendada.${NC}"
    if [ "$PKG_MANAGER" = "apt" ]; then
        read -r -p "    ¿Deseas actualizar a Node.js 20 LTS vía NodeSource? (s/n): " UP_NODE
        if [[ "$UP_NODE" =~ ^[sSyY]$ ]]; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt install -y nodejs
        fi
    fi
fi

# 3. Comprobar npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}[✗] npm no está disponible. Instálalo para continuar.${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] npm detectado:${NC} $(npm -v)"

# 4. Pregunta clave: ¿Ya tiene airgeddon instalado?
echo -e "\n${CYAN}────────────────────────────────────────────────────────────${NC}"
echo -e "${BOLD}Configuración de airgeddon:${NC}"

AIRGEDDON_FOUND=""
# Búsqueda previa en rutas habituales
if [ -f "$SCRIPT_DIR/../airgeddon/airgeddon.sh" ]; then
    AIRGEDDON_FOUND="$(cd "$SCRIPT_DIR/../airgeddon" && pwd)"
elif [ -f "/usr/share/airgeddon/airgeddon.sh" ]; then
    AIRGEDDON_FOUND="/usr/share/airgeddon"
elif [ -f "$SCRIPT_DIR/airgeddon/airgeddon.sh" ]; then
    AIRGEDDON_FOUND="$SCRIPT_DIR/airgeddon"
elif [ -f "$HOME/airgeddon/airgeddon.sh" ]; then
    AIRGEDDON_FOUND="$HOME/airgeddon"
fi

if [ -n "$AIRGEDDON_FOUND" ]; then
    echo -e "${GREEN}[✓] Se detectó una instalación previa de airgeddon en:${NC} $AIRGEDDON_FOUND"
    read -r -p "    ¿Deseas usar esta instalación? (S/n): " USE_DETECTED
    if [[ ! "$USE_DETECTED" =~ ^[nN]$ ]]; then
        export AIRGEDDON_DIR="$AIRGEDDON_FOUND"
    fi
fi

if [ -z "$AIRGEDDON_DIR" ]; then
    read -r -p "    ¿Ya tienes airgeddon instalado en otra ruta de tu equipo? (s/N): " HAS_AIRGEDDON
    if [[ "$HAS_AIRGEDDON" =~ ^[sSyY]$ ]]; then
        read -r -p "    Introduce la ruta a la carpeta de airgeddon (ej: /home/usuario/airgeddon): " CUSTOM_DIR
        if [ -f "$CUSTOM_DIR/airgeddon.sh" ]; then
            AIRGEDDON_DIR="$(cd "$CUSTOM_DIR" && pwd)"
            export AIRGEDDON_DIR
            echo -e "${GREEN}[✓] Ruta de airgeddon confirmada:${NC} $AIRGEDDON_DIR"
        else
            echo -e "${YELLOW}[!] No se encontró airgeddon.sh en esa ruta.${NC}"
        fi
    fi
fi

# Si aún no está configurado, descargarlo automáticamente desde la fuente oficial
if [ -z "$AIRGEDDON_DIR" ]; then
    echo -e "${YELLOW}[*] airgeddon no está instalado localmente.${NC}"
    echo -e "${BLUE}[*] Descargando airgeddon oficial desde GitHub (https://github.com/v1s1t0r1sh3r3/airgeddon)...${NC}"
    TARGET_CLONE="$SCRIPT_DIR/../airgeddon"
    if [ ! -d "$TARGET_CLONE" ]; then
        git clone https://github.com/v1s1t0r1sh3r3/airgeddon.git "$TARGET_CLONE"
    fi
    AIRGEDDON_DIR="$(cd "$TARGET_CLONE" && pwd)"
    export AIRGEDDON_DIR
    echo -e "${GREEN}[✓] airgeddon clonado y listo en:${NC} $AIRGEDDON_DIR"
fi

# 5. Comprobar herramientas de auditoría inalámbrica
echo -e "\n${CYAN}────────────────────────────────────────────────────────────${NC}"
echo -e "${BOLD}Herramientas de auditoría inalámbrica complementarias:${NC}"
MISSING_TOOLS=()
for tool in aircrack-ng xterm curl iw; do
    if ! command -v "$tool" &> /dev/null; then
        MISSING_TOOLS+=("$tool")
    fi
done

# node-pty es un módulo nativo: necesita compilador y Python para compilarse.
if ! command -v cc &> /dev/null || ! command -v python3 &> /dev/null; then
    MISSING_TOOLS+=("build-essential")
fi

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo -e "${YELLOW}[!] Las siguientes herramientas recomendadas no están instaladas: ${MISSING_TOOLS[*]}${NC}"
    read -r -p "    ¿Deseas instalarlas ahora con tu gestor de paquetes ($PKG_MANAGER)? (s/n): " INSTALL_TOOLS
    if [[ "$INSTALL_TOOLS" =~ ^[sSyY]$ ]]; then
        if [ "$PKG_MANAGER" = "pacman" ]; then
            sudo pacman -S --needed "${MISSING_TOOLS[@]}" ccze python-pillow || sudo pacman -S --needed "${MISSING_TOOLS[@]}"
        elif [ "$PKG_MANAGER" = "apt" ]; then
            sudo apt update
            sudo apt install -y "${MISSING_TOOLS[@]}" ccze python3-pil || sudo apt install -y "${MISSING_TOOLS[@]}"
        elif [ "$PKG_MANAGER" = "dnf" ]; then
            sudo dnf install -y "${MISSING_TOOLS[@]}" ccze python3-pillow || sudo dnf install -y "${MISSING_TOOLS[@]}"
        fi
    else
        echo -e "${YELLOW}[!] Recuerda que airgeddon requiere aircrack-ng y xterm para ciertas auditorías.${NC}"
    fi
else
    echo -e "${GREEN}[✓] Herramientas de auditoría detectadas correctamente (aircrack-ng, xterm, iw, curl).${NC}"
fi

# 6. Instalar dependencias del proyecto (npm install)
echo -e "\n${CYAN}────────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}[*] Instalando dependencias de Node.js (node_modules)...${NC}"
npm install
echo -e "${GREEN}[✓] Dependencias de Node.js instaladas correctamente.${NC}"

# 7. Permisos de ejecución
chmod +x "$SCRIPT_DIR/airgeddon-gui.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/install-desktop.sh" 2>/dev/null || true

# 8. Integración en el escritorio de Linux (.desktop e iconos)
echo -e "\n${CYAN}────────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}[*] Creando acceso directo en el menú de aplicaciones de tu sistema...${NC}"
bash "$SCRIPT_DIR/install-desktop.sh"

# 9. Resumen final
echo -e "\n${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}         ¡Instalación completada con éxito!                 ${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
echo -e "  airgeddon GUI ya está completamente instalado y configurado."
echo -e ""
echo -e "  ${BOLD}Puedes iniciarlo de dos maneras:${NC}"
echo -e "  1. ${CYAN}Desde tu menú de aplicaciones:${NC} Busca ${BOLD}'airgeddon'${NC} en tus programas."
echo -e "  2. ${CYAN}Desde la terminal:${NC} Ejecuta ${BOLD}./airgeddon-gui.sh${NC}"
echo -e ""
echo -e "  ${YELLOW}¡Disfruta de tus auditorías con interfaz gráfica nativa!${NC}\n"
