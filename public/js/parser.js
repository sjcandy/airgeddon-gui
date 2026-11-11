'use strict';

window.AG = window.AG || {};

/**
 * Parser de pantalla.
 *
 * En lugar de acumular toda la salida ANSI (donde los menús antiguos se
 * mezclan con los nuevos), leemos la pantalla visible de xterm. airgeddon
 * usa `clear` antes de cada menú y `read -rp "> "` para pedir entrada, así
 * que el último bloque visible es siempre la interacción vigente.
 */
AG.parser = (() => {
  const CONTEXTS = [
    { id: 'main', re: /men[uú]\s+principal|main\s+menu/i, name: 'Menú principal', icon: 'layout-dashboard', color: 'teal', desc: 'Panel principal de airgeddon' },
    { id: 'select_interface', re: /selecciona.*interfaz|select.*interface|tarjeta.*red/i, name: 'Seleccionar Interfaz', icon: 'network', color: 'teal', desc: 'Elige la interfaz de red para las operaciones' },
    { id: 'dos', re: /ataques?\s+dos|denial\s+of\s+service|\bdos\b/i, name: 'Ataques DoS', icon: 'bomb', color: 'red', desc: 'Desautenticación, autenticación flood y beacon flood' },
    { id: 'handshake', re: /handshake|pmkid|decloak/i, name: 'Handshake / PMKID', icon: 'key-round', color: 'amber', desc: 'Captura de handshakes y PMKID' },
    { id: 'decrypt', re: /descifrado|decrypt|crack/i, name: 'Descifrado WPA/WPA2', icon: 'lock-open', color: 'purple', desc: 'Cracking offline con diccionarios' },
    { id: 'evil_twin', re: /evil\s*twin/i, name: 'Evil Twin', icon: 'ghost', color: 'pink', desc: 'AP falso, portal cautivo y sniffing' },
    { id: 'wps', re: /ataques?\s+wps|\bwps\b/i, name: 'Ataques WPS', icon: 'scan-line', color: 'amber', desc: 'PIN, Pixie Dust y fuerza bruta' },
    { id: 'wep', re: /ataques?\s+wep|\bwep\b/i, name: 'Ataques WEP', icon: 'shield-off', color: 'green', desc: 'Captura de IVs y cracking WEP' },
    { id: 'enterprise', re: /enterprise|radius/i, name: 'Enterprise', icon: 'building-2', color: 'blue', desc: 'WPA/WPA2 Enterprise y RADIUS' },
    { id: 'wpa3', re: /wpa3|dragonfly|\bsae\b/i, name: 'WPA3', icon: 'shield-alert', color: 'purple', desc: 'Dragonfly, SAE y downgrade' },
    { id: 'options', re: /opciones|idioma|language|options/i, name: 'Opciones e idioma', icon: 'languages', color: 'slate', desc: 'Preferencias del script' },
    { id: 'scanning', re: /explorar|exploring|buscando\s+objetivos|scanning/i, name: 'Explorando objetivos', icon: 'radar', color: 'teal', desc: 'Buscando redes cercanas' },
    { id: 'target', re: /seleccionar\s+objetivo|select.*target|red\s+objetivo/i, name: 'Selección de objetivo', icon: 'crosshair', color: 'teal', desc: 'Elige la red objetivo' },
    { id: 'attack', re: /ataque|attack|capturando|capturing/i, name: 'Ataque en curso', icon: 'zap', color: 'red', desc: 'Ataque o captura en ejecución' },
  ];

  const UNKNOWN_CONTEXT = { id: 'unknown', name: 'airgeddon', icon: 'terminal', color: 'slate', desc: 'Script en ejecución' };
  const ERROR_CONTEXT = { id: 'error', name: 'Error', icon: 'alert-circle', color: 'red', desc: 'Se detectó un error' };
  const SUCCESS_CONTEXT = { id: 'success', name: 'Completado', icon: 'check-circle-2', color: 'green', desc: 'Tarea completada' };

  const HINTS = [
    { re: /volver|regresar|back\b/i, title: 'Volver', desc: 'Regresar al menú anterior', icon: 'arrow-left', color: 'slate' },
    { re: /salir|exit|quit|cerrar\s+airgeddon/i, title: 'Salir', desc: 'Cerrar airgeddon', icon: 'log-out', color: 'red', destructive: true },
    { re: /selecciona\s+otra\s+interfaz|select.*interface|cambiar.*interfaz/i, title: 'Cambiar interfaz', desc: 'Elegir otra tarjeta de red', icon: 'network', color: 'teal' },
    { re: /modo\s+monitor|monitor\s+mode|poner.*monitor/i, title: 'Activar modo monitor', desc: 'Preparar la tarjeta para capturar paquetes', icon: 'radio', color: 'green' },
    { re: /modo\s+managed|managed\s+mode|poner.*managed/i, title: 'Volver a managed', desc: 'Devolver la tarjeta al modo normal', icon: 'wifi', color: 'blue' },
    { re: /explorar.*objetivo|explore.*target|buscar\s+objetivos|escanear\s+redes/i, title: 'Escanear redes', desc: 'Buscar redes y clientes cercanos', icon: 'radar', color: 'teal' },
    { re: /captur.*handshake|handshake.*captur|capturar\s+handshake/i, title: 'Capturar handshake', desc: 'Interceptar el handshake WPA de 4 vías', icon: 'key-round', color: 'amber' },
    { re: /pmkid/i, title: 'Capturar PMKID', desc: 'Obtener un PMKID para cracking offline', icon: 'fingerprint', color: 'amber' },
    { re: /decloak|desautentic|deauth|disassoc/i, title: 'Decloaking / Deauth', desc: 'Expulsar clientes para forzar reconexión', icon: 'zap', color: 'red' },
    { re: /evil\s*twin.*portal|portal\s+cautivo|captive\s+portal/i, title: 'Evil Twin + portal', desc: 'AP falso con portal para capturar credenciales', icon: 'ghost', color: 'pink' },
    { re: /evil\s*twin.*sniff|sniffing/i, title: 'Evil Twin + sniffing', desc: 'AP falso para interceptar tráfico', icon: 'eye', color: 'pink' },
    { re: /evil\s*twin.*bettercap|bettercap/i, title: 'Evil Twin + bettercap', desc: 'Interceptación SSL con bettercap', icon: 'shield-alert', color: 'pink' },
    { re: /pixie\s*dust|pixie/i, title: 'Pixie Dust', desc: 'Ataque WPS offline muy rápido', icon: 'sparkles', color: 'amber' },
    { re: /pin.*(brute|force)|fuerza\s+bruta.*pin|bruteforce.*pin/i, title: 'Fuerza bruta de PIN', desc: 'Probar PINs WPS uno a uno', icon: 'hash', color: 'amber' },
    { re: /wps.*pin|pin.*wps/i, title: 'Ataque PIN WPS', desc: 'Recuperar la clave mediante WPS', icon: 'scan-line', color: 'amber' },
    { re: /deauth.*mdk|mdk.*deauth|amok/i, title: 'Deauth masivo (mdk)', desc: 'Desautenticación masiva con mdk', icon: 'bomb', color: 'red' },
    { re: /deauth.*aireplay|aireplay/i, title: 'Deauth dirigido (aireplay)', desc: 'Desautenticación precisa con aireplay-ng', icon: 'crosshair', color: 'red' },
    { re: /auth.*dos|autenticaci[oó]n.*dos/i, title: 'Auth DoS', desc: 'Saturar el AP con solicitudes de autenticación', icon: 'bomb', color: 'red' },
    { re: /michael|shutdown/i, title: 'Michael shutdown', desc: 'Explotar TKIP para forzar el apagado del AP', icon: 'power', color: 'red' },
    { re: /beacon.*flood|beacon/i, title: 'Beacon flood', desc: 'Inundar el área con redes falsas', icon: 'radio', color: 'red' },
    { re: /wep/i, title: 'Ataque WEP', desc: 'Captura de IVs y cracking WEP', icon: 'shield-off', color: 'green' },
    { re: /enterprise/i, title: 'Ataque Enterprise', desc: 'RADIUS, identidades y certificados', icon: 'building-2', color: 'blue' },
    { re: /wpa3|dragonfly|\bsae\b/i, title: 'Ataque WPA3', desc: 'Dragonfly, SAE y downgrade', icon: 'shield-alert', color: 'purple' },
    { re: /descifr|decrypt|crack/i, title: 'Descifrar', desc: 'Cracking offline del handshake', icon: 'lock-open', color: 'purple' },
    { re: /diccionario|dictionary|wordlist/i, title: 'Diccionario', desc: 'Usar una lista de contraseñas', icon: 'book-open', color: 'purple' },
    { re: /limpiar|optimizar|clean/i, title: 'Limpiar handshake', desc: 'Optimizar el archivo capturado', icon: 'eraser', color: 'slate' },
    { re: /idioma|language/i, title: 'Idioma', desc: 'Cambiar el idioma de airgeddon', icon: 'languages', color: 'slate' },
    { re: /cr[eé]ditos|credits/i, title: 'Créditos', desc: 'Autor y patrocinadores', icon: 'heart', color: 'slate' },
  ];

  const SEPARATOR_RE = /^[\s─═━╔╗╚╝║╠╣╦╩╬│┃+\-=_*·.]*$/;
  const MAC_RE = /(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/;
  // Prefijo del consejo que airgeddon imprime bajo los menús (print_hint).
  const HINT_RE = /^\s*(consejo|hint|conseil|consell|conselho|tipp|consiglio|wskaz[oó]wka|подсказка|συμβουλ[ήη])\b/i;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function cleanLine(line) {
    return String(line || '')
      .replace(/[─═━╔╗╚╝║╠╣╦╩╬│┃]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findLastNonEmpty(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (String(lines[i] || '').trim()) return i;
    }
    return -1;
  }

  function detectTitle(lines, endIdx = lines.length) {
    const start = Math.max(0, endIdx - 80);
    // 1. Buscamos hacia atrás desde el prompt la cabecera con asteriscos más cercana (ej: *** Menú principal airgeddon v12.02 ***)
    for (let i = endIdx - 1; i >= start; i--) {
      const raw = String(lines[i] || '');
      if (!raw.trim()) continue;
      const cleaned = cleanLine(raw);
      if (!cleaned || SEPARATOR_RE.test(cleaned) || /^\s*\d{1,2}[.)]\s/.test(cleaned)) continue;
      const banner = cleaned.match(/\*{3,}\s*(.+?)\s*\*{3,}/);
      if (banner && banner[1].trim()) {
        return banner[1].trim().slice(0, 180);
      }
    }
    // 2. Si no hay banner con asteriscos, buscamos líneas no numeradas con palabras clave de títulos
    for (let i = endIdx - 1; i >= start; i--) {
      const raw = String(lines[i] || '');
      if (!raw.trim()) continue;
      const cleaned = cleanLine(raw);
      if (!cleaned || SEPARATOR_RE.test(cleaned) || /^\s*\d{1,2}[.)]\s/.test(cleaned)) continue;
      if (/men[uú]|airgeddon|ataque|evil\s*twin|desautentic|explorar|seleccionar\s+objetivo|exploring|targets|opciones|language/i.test(cleaned)) {
        return cleaned.replace(/\*+/g, '').trim().slice(0, 180);
      }
    }
    // 3. Fallback: buscar desde las primeras líneas excluyendo opciones numeradas
    const limit = Math.min(lines.length, 24);
    for (let i = 0; i < limit; i++) {
      const raw = String(lines[i] || '');
      if (!raw.trim()) continue;
      const cleaned = cleanLine(raw);
      if (!cleaned || SEPARATOR_RE.test(cleaned) || /^\s*\d{1,2}[.)]\s/.test(cleaned)) continue;
      if (/men[uú]|airgeddon|ataque|evil|desautentic|explorar|targets|opciones|language/i.test(cleaned)) {
        return cleaned.replace(/\*+/g, '').trim().slice(0, 180);
      }
    }
    return '';
  }

  function detectContext(title, lines, items) {
    // El título manda. Si no identifica el contexto, se miran las primeras
    // líneas de la pantalla, excluyendo las entradas de menú: frases como
    // "Volver al menú principal" dentro del menú DoS no deben convertirlo en
    // el menú principal.
    const titleText = String(title || '');
    if (titleText) {
      for (const ctx of CONTEXTS) {
        if (ctx.re.test(titleText)) return ctx;
      }
    }

    const header = lines.slice(0, 20)
      .map((line) => String(line || ''))
      .filter((line) => line.trim() && !/^\s*\d{1,2}[.)]\s/.test(line) && !SEPARATOR_RE.test(line))
      .join('\n');
    const haystack = `${titleText}\n${header}`;
    for (const ctx of CONTEXTS) {
      if (ctx.re.test(haystack)) return ctx;
    }
    const itemText = items.map((it) => normalize(it.text)).join(' | ');

    // Si contiene opciones exclusivas del menú principal (seleccionar interfaz, modo monitor, modo managed, acerca de & créditos, opciones e idioma), ES EL MENÚ PRINCIPAL
    if (items.some((it) => /selecciona.*interfaz|modo\s+monitor|modo\s+managed|acerca\s+de\s+&\s+cr[eé]ditos|opciones\s+e\s+idioma/i.test(it.text))) {
      return CONTEXTS.find((c) => c.id === 'main') || UNKNOWN_CONTEXT;
    }

    if (items.some((it) => /chipset/i.test(it.text) || (/wlan|enp|wlp|eth/i.test(it.text) && !/ataque|modo/i.test(it.text)))) {
      return CONTEXTS.find((c) => c.id === 'select_interface') || UNKNOWN_CONTEXT;
    }

    if (itemText.includes('evil twin') || itemText.includes('desautenticacion') || itemText.includes('mdk4') || itemText.includes('aireplay')) {
      return CONTEXTS.find((c) => c.id === 'evil_twin') || UNKNOWN_CONTEXT;
    }
    if (itemText.includes('ataques dos')) return CONTEXTS.find((c) => c.id === 'dos');
    if (itemText.includes('handshake') || itemText.includes('pmkid')) return CONTEXTS.find((c) => c.id === 'handshake');
    if (itemText.includes('wps')) return CONTEXTS.find((c) => c.id === 'wps');
    if (itemText.includes('wep')) return CONTEXTS.find((c) => c.id === 'wep');
    if (itemText.includes('enterprise')) return CONTEXTS.find((c) => c.id === 'enterprise');
    if (itemText.includes('wpa3')) return CONTEXTS.find((c) => c.id === 'wpa3');
    if (itemText.includes('descifrado') || itemText.includes('decrypt')) return CONTEXTS.find((c) => c.id === 'decrypt');
    if (itemText.includes('menú de opciones') || itemText.includes('idioma')) return CONTEXTS.find((c) => c.id === 'options');
    return UNKNOWN_CONTEXT;
  }

  function parseMenuItems(lines, endIdx) {
    const start = Math.max(0, endIdx - 90);
    let menuStart = start;
    // Buscamos hacia atrás el inicio del bloque de este menú (la cabecera o "Selecciona una opción")
    for (let i = endIdx - 1; i >= start; i--) {
      const line = String(lines[i] || '').trim();
      if (/\*{3,}/.test(line) || /selecciona\s+una\s+opci[oó]n|select\s+an\s+option/i.test(line)) {
        menuStart = i;
        break;
      }
    }
    const byKey = new Map();
    const order = [];
    for (let i = menuStart; i < endIdx; i++) {
      const raw = String(lines[i] || '');
      const line = raw.trim();
      if (!line) continue;
      if (MAC_RE.test(line) && line.includes('%')) continue;
      let m = line.match(/^(\d{1,2})\.\s+(.+)$/);
      if (!m) m = line.match(/^(\d{1,2})\)\s+(.+)$/);
      if (!m) continue;
      const key = m[1];
      // Se conserva el texto tal cual lo imprime airgeddon. La GUI puede
      // añadir un icono o una descripción de ayuda, pero nunca debe reescribir
      // la opción: el usuario tiene que reconocer lo que ve en la consola.
      const text = m[2].trim();
      if (!text || text.length > 220) continue;
      if (/^[0-9A-Fa-f:]{17}/.test(text)) continue;
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, { key, text });
    }
    if (byKey.size < 2) return [];
    return order.map((key) => byKey.get(key));
  }

  function normalizeBand(band) {
    const b = String(band || '').replace(/\s+/g, ' ').trim();
    if (!b) return '—';
    if (/^2\.4\s*\/\s*6/i.test(b)) return '2.4/6 GHz';
    if (/^5\s*\/\s*6/i.test(b)) return '5/6 GHz';
    if (/^2\.4/i.test(b)) return '2.4 GHz';
    if (/^5/i.test(b)) return '5 GHz';
    if (/^6/i.test(b)) return '6 GHz';
    return b;
  }

  function securityKind(enc) {
    const e = normalize(enc);
    if (/wpa3|sae/.test(e)) return 'wpa3';
    if (/wpa2|rsn|ccmp/.test(e)) return 'wpa2';
    if (/wpa/.test(e)) return 'wpa';
    if (/wep/.test(e)) return 'wep';
    if (/opn|open|abierta/.test(e)) return 'open';
    return 'other';
  }

  function parseNets(lines, endIdx) {
    const start = Math.max(0, endIdx - 80);
    const nets = [];
    const seen = new Set();
    for (let i = start; i < endIdx; i++) {
      const line = String(lines[i] || '').trim();
      const m = line.match(/^(\d{1,3})\)\s*(\*)?\s*((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(.+)$/);
      if (!m) continue;
      const n = m[1];
      const hasStar = Boolean(m[2]);
      const bssid = m[3].toUpperCase();
      if (seen.has(n)) continue;
      seen.add(n);
      const rest = m[4].trim();
      let channel = '—';
      let band = '';
      let power = 0;
      let enc = '—';
      let essid = '';

      let r = rest.match(/^(\S+)\s+(?:(\S+)\s+)?(-?\d+)%\s+(\S+)\s+(.*)$/);
      if (r) {
        channel = r[1];
        band = r[2] || '';
        power = Number(r[3]) || 0;
        enc = r[4];
        essid = r[5].trim();
      } else {
        // Fallback por columnas: canal, banda opcional, potencia%, cifrado, ESSID
        const powerMatch = rest.match(/(-?\d+)%/);
        if (powerMatch) {
          power = Number(powerMatch[1]) || 0;
          const before = rest.slice(0, powerMatch.index).trim().split(/\s+/);
          channel = before[0] || '—';
          band = before.length > 1 ? before.slice(1).join(' ') : '';
          const after = rest.slice(powerMatch.index + powerMatch[0].length).trim();
          const encMatch = after.match(/^(\S+)\s+(.*)$/);
          if (encMatch) { enc = encMatch[1]; essid = encMatch[2].trim(); }
          else { enc = after || '—'; }
        } else {
          const parts = rest.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 3) {
            channel = parts[0];
            power = parseInt(parts[1], 10) || 0;
            enc = parts[2];
            essid = parts.slice(3).join(' ');
          }
        }
      }

      if (!/^\d+$/.test(channel)) {
        const chNum = parseInt(channel, 10);
        channel = Number.isFinite(chNum) && chNum > 0 ? String(chNum) : '—';
      }
      const chNum = parseInt(channel, 10);
      if (!band || !/(ghz|2\.4|5g|6g)/i.test(band)) {
        if (Number.isFinite(chNum) && chNum > 0) band = chNum <= 14 ? '2.4 GHz' : '5 GHz';
        else band = '—';
      }
      band = normalizeBand(band);
      if (!essid || essid === '(Hidden Network)') essid = '(oculta)';

      // airgeddon muestra la potencia en dBm (negativa); las barras usan %.
      const signal = power < 0
        ? Math.max(0, Math.min(100, Math.round((power + 100) * 2)))
        : Math.max(0, Math.min(100, Math.round(power)));

      nets.push({
        n,
        bssid,
        channel,
        band,
        power,
        signal,
        enc: enc === '—' ? '—' : enc,
        securityKind: securityKind(enc),
        essid,
        hasClients: hasStar,
        clients: hasStar ? '1+' : '0',
      });
    }
    return nets;
  }

  const NAV_META = [
    { re: /ataques?\s+dos/i, icon: 'bomb', color: 'red' },
    { re: /handshake|pmkid|decloak/i, icon: 'key-round', color: 'amber' },
    { re: /descifrado|decrypt/i, icon: 'lock-open', color: 'purple' },
    { re: /evil\s*twin/i, icon: 'ghost', color: 'pink' },
    { re: /ataques?\s+wps|\bwps\b/i, icon: 'scan-line', color: 'amber' },
    { re: /ataques?\s+wep|\bwep\b/i, icon: 'shield-off', color: 'green' },
    { re: /enterprise/i, icon: 'building-2', color: 'blue' },
    { re: /wpa3/i, icon: 'shield-alert', color: 'purple' },
    { re: /opciones|idioma|language/i, icon: 'languages', color: 'slate' },
    { re: /cr[eé]ditos|credits/i, icon: 'heart', color: 'slate' },
    { re: /acerca/i, icon: 'info', color: 'slate' },
  ];

  function isNavigation(text) {
    // Las entradas de navegación ("Menú de ...") describen una sección, no una
    // acción concreta. No deben reescribirse con la pista de la primera palabra
    // que coincida (p. ej. PMKID dentro de "Menú de herramientas Handshake...").
    return /^(menu|submenu)(\s|$)/.test(normalize(text).trim());
  }

  function enrichItem(item) {
    const norm = normalize(item.text);
    if (item.text.includes(' // ')) {
      const parts = item.text.split(' // ');
      const title = parts[0].trim();
      const desc = parts.slice(1).join(' · ').trim();
      const isWifi = /wlan|wifi/i.test(title);
      return {
        ...item,
        title,
        desc,
        icon: isWifi ? 'wifi' : 'network',
        color: isWifi ? 'green' : 'teal',
        destructive: false,
      };
    }
    if (isNavigation(item.text)) {
      const meta = NAV_META.find((m) => m.re.test(norm)) || {};
      return {
        ...item,
        // El título es siempre el texto original de airgeddon.
        title: item.text,
        desc: '',
        icon: meta.icon || 'folder-tree',
        color: meta.color || 'slate',
        destructive: false,
        navigation: true,
      };
    }
    for (const hint of HINTS) {
      if (hint.re.test(norm)) {
        return {
          ...item,
          title: item.text,
          // La descripción es solo una ayuda visual; no sustituye al texto.
          desc: hint.desc || '',
          icon: hint.icon || 'chevron-right',
          color: hint.color || 'slate',
          destructive: Boolean(hint.destructive),
        };
      }
    }
    return {
      ...item,
      title: item.text,
      desc: '',
      icon: 'chevron-right',
      color: 'slate',
      destructive: false,
    };
  }

  function findQuestion(lines, endIdx, promptLine) {
    // Si el prompt está en la misma línea que el texto: "Introduce el BSSID: >"
    const inline = String(promptLine || '').replace(/[>\s]+$/, '').trim();
    if (inline && inline.length > 4 && inline !== '>') return inline.slice(-260);

    for (let i = endIdx - 1; i >= 0; i--) {
      const raw = String(lines[i] || '').trim();
      if (!raw) continue;
      const cleaned = cleanLine(raw);
      if (!cleaned || SEPARATOR_RE.test(cleaned)) continue;
      if (/^\[[yYnNsS]\/[yYnNsS]\]$/.test(cleaned)) continue;
      return cleaned.slice(0, 300);
    }
    return '';
  }

  function parseHint(lines, endIdx) {
    const start = Math.max(0, endIdx - 50);
    for (let i = start; i < endIdx; i++) {
      const raw = String(lines[i] || '').trim();
      if (!raw) continue;
      if (HINT_RE.test(raw)) {
        const cleaned = cleanLine(raw).slice(0, 600);
        // Omitir consejos con rutas locales fijas (.airgeddonrc, etc.)
        if (/\.airgeddonrc|fichero\s+\//i.test(cleaned)) continue;
        return cleaned;
      }
    }
    return '';
  }

  function parseIfaceStatus(lines, endIdx = lines.length) {
    const start = Math.max(0, endIdx - 60);
    for (let i = start; i < endIdx; i++) {
      const line = cleanLine(String(lines[i] || ''));
      const m = line.match(/interfaz\s+([a-zA-Z0-9_\-]+)\s+seleccionada\.?\s*modo:\s*([^.\n]+)/i);
      if (m) {
        const iface = m[1].trim();
        const mode = m[2].trim();
        const isNonWifi = /non\s*wifi/i.test(mode);
        const isMonitor = /monitor/i.test(mode);
        const isManaged = /managed/i.test(mode);
        return { iface, mode, isNonWifi, isMonitor, isManaged };
      }
    }
    return null;
  }

  function buildSignature(type, context, payload) {
    return `${type}|${context ? context.id : 'none'}|${payload}`;
  }

  function analyze(screen) {
    if (!screen || !Array.isArray(screen.lines) || !screen.lines.length) return null;
    const lines = screen.lines;
    const cursor = Math.max(0, Math.min(Number(screen.cursorY) || 0, lines.length - 1));
    const lastIdx = findLastNonEmpty(lines);
    if (lastIdx < 0) return null;
    const last = String(lines[lastIdx] || '').trim();
    const prev = lastIdx > 0 ? String(lines[lastIdx - 1] || '').trim() : '';
    const last2 = `${prev} ${last}`.trim();

    // ── 1) Contraseña de sudo ──────────────────────────────────────────────
    if (/(\[sudo\]|password\s+for|contrase[ñn]a\s+(para|de)|contrase[ñn]a\s*:)/i.test(last2) && /:\s*$/.test(last)) {
      const context = UNKNOWN_CONTEXT;
      return {
        type: 'password',
        context,
        title: 'Contraseña de sudo',
        desc: 'airgeddon necesita permisos de administrador para continuar.',
        question: 'Escribe la contraseña de tu usuario para sudo.',
        signature: buildSignature('password', context, 'sudo'),
      };
    }

    // ── 2) Confirmación [y/N] / [Y/n] / (s/n) ─────────────────────────────
    let confirmLine = last;
    let isPromptNext = false;
    if ((last === '>' || /^>\s*$/.test(last) || last.endsWith('>')) && prev) {
      if (/(\[[yYnNsS]\/[yYnNsS]\]|\([yYnNsS]\/[yYnNsS]\))\s*$/i.test(prev)) {
        confirmLine = prev;
        isPromptNext = true;
      }
    }
    const confirmMatch = confirmLine.match(/(\[[yYnNsS]\/[yYnNsS]\]|\([yYnNsS]\/[yYnNsS]\))\s*$/i);
    if (confirmMatch) {
      let question = confirmLine.replace(confirmMatch[0], '').trim();
      if (question.length < 8) {
        const lineBefore = isPromptNext ? (lines[lastIdx - 2] || '') : prev;
        question = `${lineBefore} ${question}`.trim();
      }
      question = cleanLine(question).replace(/\s+$/, '');
      if (!question) question = '¿Deseas continuar?';
      if (!/[?¿]$/.test(question)) question += '?';
      const defaultYes = /^\[[yY]\//.test(confirmMatch[0]) || /^\([yY]\//.test(confirmMatch[0]);
      const items = parseMenuItems(lines, lastIdx);
      const context = detectContext(detectTitle(lines, lastIdx), lines, items);
      return {
        type: 'confirm',
        context,
        title: 'Confirmación requerida',
        desc: 'airgeddon espera una respuesta de sí o no.',
        question,
        defaultYes,
        signature: buildSignature('confirm', context, question),
      };
    }

    // ── 3) Pulsa Enter ─────────────────────────────────────────────────────
    if (/pulsa.*(enter|intro)|press.*enter|pulsa\s+la\s+tecla\s+\[enter\]|presiona.*enter/i.test(last2)) {
      const items = parseMenuItems(lines, lastIdx);
      const context = detectContext(detectTitle(lines, lastIdx), lines, items);
      const enterQuestion = cleanLine(last2);

      // Buscar el mensaje previo explicativo. Los avisos de airgeddon suelen
      // ocupar varias líneas (por ejemplo, la advertencia de una variable
      // ausente en .airgeddonrc), así que se recoge el bloque completo de
      // líneas consecutivas en lugar de solo la última.
      const skipLine = (line) =>
        !line || SEPARATOR_RE.test(line) || /^>\s*$/.test(line) ||
        /^pulsa/i.test(line) || /^continuar/i.test(line);

      const block = [];
      for (let i = lastIdx - 1; i >= Math.max(0, lastIdx - 8); i--) {
        const line = cleanLine(String(lines[i] || ''));
        if (skipLine(line)) {
          // Un separador corta el bloque: lo que hay por encima pertenece a
          // otra sección (por ejemplo, el menú anterior).
          if (SEPARATOR_RE.test(line) && block.length) break;
          continue;
        }
        block.unshift(line);
      }
      // Se conserva el bloque tal cual, pero se limita su longitud para que el
      // modal no se llene de texto.
      let precedingMessage = block.join(' ').trim();
      if (precedingMessage.length > 400) {
        precedingMessage = precedingMessage.slice(0, 400).trimEnd() + '…';
      }

      let isError = false;
      let isWarning = false;
      let isSuccess = false;
      let title = 'Continuar';
      let desc = 'airgeddon está esperando tu confirmación.';
      // Marca que `desc` es el texto genérico por defecto, para que la interfaz
      // no lo repita (ya aparece como subtítulo en la cabecera del modal).
      let isDefaultDesc = true;
      let suggestion = '';
      let buttonText = 'Continuar';
      let color = context.color || 'teal';
      let icon = 'corner-down-left';

      if (/no es una tarjeta wifi|no soporta modo monitor|not a wifi|no support.*monitor/i.test(precedingMessage)) {
        isError = true;
        color = 'red';
        icon = 'shield-alert';
        title = 'Interfaz incompatible con modo monitor';
        desc = 'La tarjeta seleccionada no es inalámbrica o no soporta el modo monitor.';
        suggestion = 'Selecciona una tarjeta WiFi compatible (como wlan0) desde la opción "1. Selecciona otra interfaz de red".';
        buttonText = 'Entendido (Volver)';
      } else if (/no lo hemos conseguido|didn't get.*handshake|fall[oó] al capturar/i.test(precedingMessage)) {
        isWarning = true;
        color = 'amber';
        icon = 'key-round';
        title = 'Handshake no capturado';
        desc = 'No se capturó el handshake en el tiempo límite establecido.';
        suggestion = 'Prueba incrementando el timeout o utiliza otro método de desautenticación.';
        buttonText = 'Continuar';
      } else if (/detectada interrupci[oó]n|interrupted/i.test(precedingMessage)) {
        isWarning = true;
        color = 'amber';
        icon = 'alert-triangle';
        title = 'Operación interrumpida';
        desc = precedingMessage;
        buttonText = 'Continuar';
      } else if (/error|fall[oó]|imposible|no se pudo|failed|denied|rechazad/i.test(precedingMessage)) {
        isError = true;
        color = 'red';
        icon = 'alert-circle';
        title = 'Error en la operación';
        desc = precedingMessage;
        buttonText = 'Entendido';
      } else if (/conseguido|éxito|success|completado|correctamente/i.test(precedingMessage)) {
        isSuccess = true;
        color = 'green';
        icon = 'check-circle-2';
        title = 'Completado con éxito';
        desc = precedingMessage;
        buttonText = 'Continuar';
      }

      // Si el mensaje previo aporta un texto propio (por ejemplo el aviso de
      // una variable ausente en .airgeddonrc), ese texto pasa a ser el
      // subtítulo informative y deja de ser el mensaje genérico.
      if (precedingMessage && precedingMessage !== desc) {
        desc = precedingMessage;
        isDefaultDesc = false;
      }

      return {
        type: 'enter',
        context,
        title,
        desc,
        // Si no hay mensaje previo, la pregunta es el propio aviso de
        // "Pulsa Enter" en lugar del prompt "> " de la terminal.
        question: precedingMessage
          || (enterQuestion.replace(/>\s*$/, '').trim() || 'Pulsa la tecla [Enter] para continuar...'),
        suggestion,
        buttonText,
        isError,
        isWarning,
        isSuccess,
        isDefaultDesc,
        color,
        icon,
        signature: buildSignature('enter', context, `${enterQuestion}|${precedingMessage}`),
      };
    }

    // ── 4) Prompt "> " (menú, red o texto) ─────────────────────────────────
    const promptLine = last === '>' || /^>\s*$/.test(last) || (last.endsWith('>') && last.length <= 4)
      || /selecciona\s+(?:la\s+)?red\s+objetivo/i.test(last)
      || /selecciona\s+(?:la\s+)?red\s+objetivo/i.test(prev);
    if (promptLine) {
      const nets = parseNets(lines, lastIdx);
      const title = detectTitle(lines, lastIdx);
      const items = parseMenuItems(lines, lastIdx);
      const context = detectContext(title, lines, items);
      const hint = parseHint(lines, lastIdx);

      if (nets.length >= 1) {
        const targetContext = CONTEXTS.find((c) => c.id === 'target') || { id: 'target', name: 'Objetivo', icon: 'crosshair', color: 'teal' };
        return {
          type: 'network',
          context: targetContext,
          title: 'Seleccionar Red Objetivo',
          desc: `${nets.length} ${nets.length === 1 ? 'red detectada' : 'redes detectadas'}. Haz clic para auditar.`,
          nets,
          hint,
          signature: buildSignature('network', targetContext, nets.map((n) => `${n.n}:${n.bssid}:${n.essid}`).join('~')),
        };
      }

      if (items.length >= 2) {
        const ifaceStatus = parseIfaceStatus(lines, lastIdx);
        let enriched = items.map(enrichItem);
        let menuDesc = context.desc || 'Elige una opción para continuar.';

        if (ifaceStatus && ifaceStatus.isNonWifi && context.id === 'main') {
          menuDesc = `⚠️ La interfaz actual (${ifaceStatus.iface}) no es WiFi. Selecciona tu tarjeta inalámbrica en la opción 1.`;
          enriched = enriched.map((it) => {
            if (it.key === '1') {
              return { ...it, desc: '👉 Selecciona tu tarjeta WiFi aquí', color: 'green' };
            }
            if (it.key === '2' || it.key === '3') {
              return { ...it, desc: `⚠️ No compatible (${ifaceStatus.iface} no es WiFi)`, color: 'slate' };
            }
            return it;
          });
        }

        return {
          type: 'menu',
          context,
          ifaceStatus,
          title: context.id === 'unknown' ? 'Selecciona una opción' : context.name,
          desc: menuDesc,
          items: enriched,
          hint,
          signature: buildSignature('menu', context, enriched.map((it) => `${it.key}:${it.text}`).join('~')),
        };
      }

      const question = findQuestion(lines, lastIdx, last);
      return {
        type: 'text',
        context,
        title: 'Entrada requerida',
        desc: 'Escribe el valor y pulsa Enter.',
        question: question || 'Introduce un valor para continuar.',
        signature: buildSignature('text', context, question || last),
      };
    }

    // ── 5) Pregunta genérica que termina en ":" o "..." ────────────────────
    if (cursor >= lastIdx - 1 && last.length >= 6 && last.length <= 260) {
      const looksLikeQuestion = /[:?]\s*$/.test(last) || /\.\.\.\s*$/.test(last);
      const looksLikePrompt = /(escribe|introduce|selecciona|indica|nombre|ruta|bssid|canal|channel|pin|essid|password|contrase|enter|press|pulsa)/i.test(last);
      if (looksLikeQuestion && looksLikePrompt && !/^https?:\/\//i.test(last) && !MAC_RE.test(last)) {
        const items = parseMenuItems(lines, lastIdx);
        const context = detectContext(detectTitle(lines, lastIdx), lines, items);
        return {
          type: 'text',
          context,
          title: 'Entrada requerida',
          desc: 'Escribe el valor y pulsa Enter.',
          question: cleanLine(last),
          signature: buildSignature('text', context, cleanLine(last)),
        };
      }
    }

    return null;
  }

  return { analyze, CONTEXTS, UNKNOWN_CONTEXT, ERROR_CONTEXT, SUCCESS_CONTEXT, HINTS, parseNets, parseMenuItems };
})();
