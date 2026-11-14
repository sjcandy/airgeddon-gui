#!/usr/bin/env bash
# ==============================================================================
# airgeddon-gui — Script de Instalación Automatizado
# ==============================================================================
# Configura el entorno completo para un usuario nuevo:
# 1. Comprueba / instala Node.js (>=22, Node.js 24 LTS por defecto) y npm.
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
elif command -v zypper &> /dev/null; then
    PKG_MANAGER="zypper"
fi

echo -e "${BLUE}[*] Comprobando dependencias del sistema...${NC}"

# 2. Comprobar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[!] Node.js no está instalado.${NC}"
    read -r -p "    ¿Deseas instalar Node.js 24 LTS y npm automáticamente ahora? (s/n): " INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[sSyY]$ ]]; then
        if [ "$PKG_MANAGER" = "pacman" ]; then
            sudo pacman -S --needed nodejs npm
        elif [ "$PKG_MANAGER" = "apt" ]; then
            echo -e "${BLUE}[*] Configurando repositorio oficial NodeSource Node.js 24 LTS (Debian/Ubuntu/Kali/Parrot)...${NC}"
            curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
            sudo apt install -y nodejs build-essential
        elif [ "$PKG_MANAGER" = "dnf" ]; then
            echo -e "${BLUE}[*] Instalando Node.js y npm vía DNF (Fedora)...${NC}"
            sudo dnf install -y nodejs npm
        elif [ "$PKG_MANAGER" = "zypper" ]; then
            echo -e "${BLUE}[*] Instalando Node.js y npm vía Zypper (openSUSE)...${NC}"
            sudo zypper install -y nodejs npm
        else
            echo -e "${RED}[✗] Gestor de paquetes no soportado para instalación automática.${NC}"
            echo -e "    Instala Node.js >= 22 (recomendado Node.js 24 LTS) manualmente y vuelve a ejecutar este instalador."
            exit 1
        fi
    else
        echo -e "${RED}[✗] Se requiere Node.js >= 22 para ejecutar airgeddon GUI.${NC}"
        exit 1
    fi
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
echo -e "${GREEN}[✓] Node.js detectado:${NC} $(node -v)"
if [ "$NODE_VER" -lt 22 ]; then
    echo -e "${YELLOW}[!] Advertencia: Tu versión de Node.js ($(node -v)) está fuera de soporte (requerido >= 22).${NC}"
    if [ "$PKG_MANAGER" = "apt" ]; then
        read -r -p "    ¿Deseas actualizar a Node.js 24 LTS vía NodeSource? (s/n): " UP_NODE
        if [[ "$UP_NODE" =~ ^[sSyY]$ ]]; then
            curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
            sudo apt install -y nodejs build-essential
        fi
    elif [ "$PKG_MANAGER" = "pacman" ]; then
        echo -e "    Actualiza con: ${YELLOW}sudo pacman -Syu nodejs npm${NC}"
    elif [ "$PKG_MANAGER" = "dnf" ]; then
        echo -e "    Actualiza con: ${YELLOW}sudo dnf upgrade nodejs npm${NC}"
    elif [ "$PKG_MANAGER" = "zypper" ]; then
        echo -e "    Actualiza con: ${YELLOW}sudo zypper update nodejs npm${NC}"
    fi
fi

# La actualización es opcional; continuar con una versión incompatible no lo es.
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if ! [[ "$NODE_VER" =~ ^[0-9]+$ ]] || [ "$NODE_VER" -lt 22 ]; then
    echo -e "${RED}[✗] Instala Node.js >= 22 antes de continuar.${NC}"
    exit 1
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
if ! command -v cc &> /dev/null || ! command -v c++ &> /dev/null || ! command -v make &> /dev/null || ! command -v python3 &> /dev/null; then
    case "$PKG_MANAGER" in
        apt) MISSING_TOOLS+=(build-essential python3) ;;
        pacman) MISSING_TOOLS+=(base-devel python) ;;
        dnf|zypper) MISSING_TOOLS+=(gcc-c++ make python3) ;;
        *)
            echo -e "${RED}[✗] Instala un compilador C/C++, make y Python 3 antes de continuar.${NC}"
            exit 1
            ;;
    esac
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
        elif [ "$PKG_MANAGER" = "zypper" ]; then
            sudo zypper install -y "${MISSING_TOOLS[@]}"
        else
            echo -e "${RED}[✗] Instala las herramientas indicadas manualmente y vuelve a ejecutar el instalador.${NC}"
            exit 1
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

# Guardar la ubicación como datos JSON, sin crear archivos shell ejecutables.
node - "$AIRGEDDON_DIR" "${XDG_CONFIG_HOME:-$HOME/.config}/airgeddon-gui" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [airgeddonDir, configDir] = process.argv.slice(2);
if (!airgeddonDir || /[\r\n\0]/.test(airgeddonDir) || !fs.statSync(path.join(airgeddonDir, 'airgeddon.sh')).isFile()) {
  throw new Error('La ubicación de airgeddon no es válida');
}
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const stat = fs.lstatSync(configDir);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
  throw new Error('Directorio de configuración inseguro');
}
fs.chmodSync(configDir, 0o700);
const target = path.join(configDir, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Configuración no válida');
settings.airgeddonDir = airgeddonDir;
const temporary = path.join(configDir, `.settings.${crypto.randomBytes(12).toString('hex')}`);
try {
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
} finally {
  try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
NODE

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
