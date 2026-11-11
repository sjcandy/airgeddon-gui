'use strict';

window.AG = window.AG || {};

AG.terminal = (() => {
  let term = null;
  let fitAddon = null;
  let drawer = null;
  let body = null;
  let host = null;
  let logText = '';
  let currentTab = 'terminal';
  let initialized = false;
  let fontSize = 12;
  let autoScroll = true;
  let searchOverlay = null;
  let searchInput = null;
  let searchMatches = 0;
  let searchQuery = '';
  let maximized = false;
  let systemShellActive = false;

  const MAX_LOG = 600 * 1024;

  function themeFor(mode) {
    // Terminal profesional con paleta GitHub-inspired
    return {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#39d353',
      cursorAccent: '#0d1117',
      selectionBackground: 'rgba(57,211,83,.20)',
      black: '#0d1117',
      red: '#f85149',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39d353',
      white: '#e6edf3',
      brightBlack: '#484f58',
      brightRed: '#ff7b72',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d364',
      brightWhite: '#ffffff',
    };
  }

  function init() {
    if (initialized) return;
    drawer = document.getElementById('consoleDrawer');
    body = document.getElementById('consoleBody');
    host = document.getElementById('terminalHost');

    term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: fontSize,
      lineHeight: 1.18,
      fontFamily: '"JetBrains Mono","SF Mono","Cascadia Code","Fira Code",Consolas,monospace',
      theme: themeFor(document.documentElement.getAttribute('data-theme') || 'dark'),
      scrollback: 8000,
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch {}
    term.open(host);

    // Smart auto-scroll: pause when user scrolls up
    term.onScroll(() => {
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      autoScroll = atBottom;
    });

    term.onData((data) => {
      if (AG.app && typeof AG.app.terminalInput === 'function') AG.app.terminalInput(data);
    });
    term.onResize(({ cols, rows }) => {
      if (AG.app && typeof AG.app.terminalResize === 'function') AG.app.terminalResize(cols, rows);
    });

    // Keyboard shortcuts for console
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        showSearch();
        return false;
      }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize(fontSize + 1);
        return false;
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        setFontSize(fontSize - 1);
        return false;
      }
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        setFontSize(12);
        return false;
      }
      return true;
    });

    window.addEventListener('resize', () => setTimeout(fit, 80));
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => setTimeout(fit, 60));
      ro.observe(host);
    }

    bindConsole();
    createSearchOverlay();
    initialized = true;
  }

  function bindConsole() {
    const head = document.getElementById('consoleHead');
    if (head) {
      head.addEventListener('click', (e) => {
        if (e.target.closest('[data-no-toggle]') || e.target.closest('button.console-tab')) return;
        toggle();
      });
    }

    document.querySelectorAll('.console-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        switchTab(tab.dataset.ctab);
      });
    });

    const resize = document.getElementById('consoleResize');
    if (resize) {
      resize.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = drawer.offsetHeight;
        const onMove = (ev) => {
          const next = Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY)));
          drawer.style.setProperty('--console-h', `${Math.round(next)}px`);
          fit();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const h = parseInt(getComputedStyle(drawer).getPropertyValue('--console-h'), 10);
          if (Number.isFinite(h)) localStorage.setItem('ag-console-h', String(h));
          fit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    const savedH = parseInt(localStorage.getItem('ag-console-h') || '', 10);
    if (Number.isFinite(savedH)) {
      drawer.style.setProperty('--console-h', `${Math.max(120, Math.min(800, savedH))}px`);
    }

    // Load saved font size
    const savedFont = parseInt(localStorage.getItem('ag-console-font') || '', 10);
    if (Number.isFinite(savedFont) && savedFont >= 8 && savedFont <= 24) {
      fontSize = savedFont;
    }
  }

  function createSearchOverlay() {
    if (!host || searchOverlay) return;
    searchOverlay = document.createElement('div');
    searchOverlay.className = 'console-search';
    searchOverlay.innerHTML = `
      <input type="text" class="console-search-input" placeholder="Buscar en consola..." spellcheck="false">
      <span class="console-search-count">0/0</span>
      <button class="console-search-btn" data-action="search-prev" title="Anterior (Shift+Enter)">↑</button>
      <button class="console-search-btn" data-action="search-next" title="Siguiente (Enter)">↓</button>
      <button class="console-search-btn" data-action="search-close" title="Cerrar (Esc)">✕</button>
    `;
    host.parentElement.appendChild(searchOverlay);
    searchInput = searchOverlay.querySelector('.console-search-input');
    const countEl = searchOverlay.querySelector('.console-search-count');

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      performSearch();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrev();
        else searchNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSearch();
      }
    });
    searchOverlay.querySelector('[data-action="search-prev"]').addEventListener('click', searchPrev);
    searchOverlay.querySelector('[data-action="search-next"]').addEventListener('click', searchNext);
    searchOverlay.querySelector('[data-action="search-close"]').addEventListener('click', hideSearch);
  }

  function showSearch() {
    if (!searchOverlay) return;
    searchOverlay.classList.add('visible');
    searchInput.focus();
    searchInput.select();
  }

  function hideSearch() {
    if (!searchOverlay) return;
    searchOverlay.classList.remove('visible');
    searchQuery = '';
    searchInput.value = '';
    if (term) term.clearSelection();
    updateSearchCount(0, 0);
  }

  function performSearch() {
    if (!term || !searchQuery) {
      searchMatches = 0;
      if (term) term.clearSelection();
      updateSearchCount(0, 0);
      return;
    }
    try {
      const results = term.findNext(searchQuery, { incremental: true, caseSensitive: false });
      searchMatches = results ? 1 : 0;
      updateSearchCount(searchMatches, searchMatches);
    } catch {}
  }

  function searchNext() {
    if (!term || !searchQuery) return;
    try { term.findNext(searchQuery, { caseSensitive: false }); } catch {}
  }

  function searchPrev() {
    if (!term || !searchQuery) return;
    try { term.findPrevious(searchQuery, { caseSensitive: false }); } catch {}
  }

  function updateSearchCount(current, total) {
    const el = searchOverlay?.querySelector('.console-search-count');
    if (el) el.textContent = total > 0 ? `${current}/${total}` : '0/0';
  }

  function setFontSize(size) {
    size = Math.max(8, Math.min(24, size));
    fontSize = size;
    if (term) {
      try { term.options.fontSize = size; } catch {}
      fit();
    }
    try { localStorage.setItem('ag-console-font', String(size)); } catch {}
    if (AG.ui && AG.ui.toast) AG.ui.toast(`Tamaño de fuente: ${size}px`, 'info');
  }

  function getFontSize() {
    return fontSize;
  }

  function fit() {
    if (!fitAddon || !drawer) return;
    if (!drawer.classList.contains('open')) return;
    try { fitAddon.fit(); } catch {}
  }

  function setExpandIcon(name) {
    const btn = document.getElementById('consoleExpand');
    if (!btn) return;
    btn.innerHTML = AG.ui.icon(name);
    AG.ui.icons(btn);
  }

  function open(opts = {}) {
    if (!drawer) return;
    drawer.classList.add('open');
    setExpandIcon('chevron-down');
    setTimeout(() => {
      fit();
      if (opts.focus) {
        try { term.focus(); } catch {}
      }
    }, 80);
  }

  function close() {
    if (!drawer) return;
    drawer.classList.remove('open');
    setExpandIcon('chevron-up');
  }

  function toggle() {
    if (!drawer) return;
    if (drawer.classList.contains('open')) close();
    else open();
  }

  function maximize() {
    if (!drawer) return;
    if (maximized) {
      drawer.classList.remove('maximized');
      maximized = false;
    } else {
      drawer.classList.add('maximized');
      maximized = true;
    }
    setTimeout(fit, 100);
  }

  function isMaximized() {
    return maximized;
  }

  function copySelection() {
    if (!term) return;
    try {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).then(() => {
          if (AG.ui && AG.ui.toast) AG.ui.toast('Selección copiada', 'success');
        }).catch(() => {
          // Fallback para navegadores sin permiso de portapapeles
          const ta = document.createElement('textarea');
          ta.value = sel;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          if (AG.ui && AG.ui.toast) AG.ui.toast('Selección copiada', 'success');
        });
      }
    } catch {}
  }

  function isOpen() {
    return Boolean(drawer && drawer.classList.contains('open'));
  }

  const systemLogs = [];

  function addSystemLog(log) {
    if (!log) return;
    systemLogs.push(log);
    if (systemLogs.length > 500) systemLogs.shift();
    renderSystemLogs();
  }

  function setSystemLogs(logs) {
    if (Array.isArray(logs)) {
      systemLogs.length = 0;
      systemLogs.push(...logs);
      renderSystemLogs();
    }
  }

  function renderSystemLogs() {
    const host = document.getElementById('systemLogHost');
    if (!host) return;
    host.innerHTML = systemLogs.map((log) => {
      const time = new Date(log.ts || Date.now()).toTimeString().slice(0, 8);
      const level = log.level || 'info';
      const isCmd = level === 'cmd';
      const isErr = level === 'stderr' || level === 'error';
      const isWarn = level === 'warn';
      const isOut = level === 'stdout';
      const colorClass = isCmd ? 'sys-cmd' : isErr ? 'sys-stderr' : isWarn ? 'sys-warn' : isOut ? 'sys-stdout' : 'sys-info';
      const prefix = isCmd ? '$' : isErr ? '✗' : isWarn ? '!' : isOut ? '↳' : 'ℹ';
      return `<div class="sys-log-line ${colorClass}">
        <div class="sys-log-header">
          <span class="sys-time">${time}</span>
          <span class="sys-prefix">${prefix}</span>
          <span class="sys-msg">${AG.ui.esc(log.message || '')}</span>
        </div>
        ${log.data ? `<pre class="sys-data">${AG.ui.esc(log.data)}</pre>` : ''}
      </div>`;
    }).join('');
    host.scrollTop = host.scrollHeight;
  }

  function switchTab(tab) {
    currentTab = ['events', 'system'].includes(tab) ? tab : 'terminal';
    document.querySelectorAll('.console-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.ctab === currentTab);
    });
    document.getElementById('paneTerminal')?.classList.toggle('active', currentTab === 'terminal');
    document.getElementById('paneSystem')?.classList.toggle('active', currentTab === 'system');
    document.getElementById('paneEvents')?.classList.toggle('active', currentTab === 'events');
    if (currentTab === 'terminal') setTimeout(fit, 40);
  }

  function write(data) {
    if (!term) return;
    try { term.write(data); } catch {}
    logText = (logText + data).slice(-MAX_LOG);
    // Smart auto-scroll: only scroll to bottom if user hasn't scrolled up
    if (autoScroll) {
      try { term.scrollToBottom(); } catch {}
    }
  }

  function reset() {
    if (!term) return;
    try { term.reset(); } catch { try { term.clear(); } catch {} }
    logText = '';
  }

  function clear() {
    if (!term) return;
    try { term.clear(); } catch {}
    logText = '';
  }

  function getLog() {
    return logText;
  }

  function getTerm() {
    return term;
  }

  function getScreen() {
    if (!term || !term.buffer || !term.buffer.active) return null;
    const buffer = term.buffer.active;
    const totalLines = buffer.length;
    // La línea del cursor en coordenadas absolutas del buffer es buffer.baseY + buffer.cursorY.
    // Para que el analizador nunca pierda las cabeceras ni las primeras opciones de menús largos
    // (como el menú principal de airgeddon con 14 opciones) cuando la consola inferior tiene
    // pocas filas visibles, incluimos las líneas recientes del buffer (hasta 120 líneas atrás).
    const endLine = Math.min(totalLines, buffer.baseY + buffer.cursorY + 1);
    const startLine = Math.max(0, endLine - Math.max(term.rows || 24, 120));
    const lines = [];
    for (let i = startLine; i < endLine; i++) {
      const line = buffer.getLine(i);
      if (!line) { lines.push(''); continue; }
      let text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return { lines, cursorY: lines.length - 1, rows: lines.length, cols: term.cols };
  }

  function scrollToBottom() {
    if (!term) return;
    try { term.scrollToBottom(); } catch {}
    autoScroll = true;
  }

  function focus() {
    if (!term) return;
    try { term.focus(); } catch {}
  }

  function blur() {
    if (!term) return;
    try { term.blur(); } catch {}
  }

  function setStatus(running, waiting) {
    const badge = document.getElementById('consoleBadge');
    if (!badge) return;
    badge.className = `console-badge ${waiting ? 'waiting' : running ? 'running' : 'idle'}`;
    badge.textContent = waiting ? 'WAIT' : running ? 'RUNNING' : 'IDLE';
  }

  function renderEvents(events) {
    const root = document.getElementById('eventsList');
    if (!root) return;
    const list = (events || []).slice(0, 250);
    if (!list.length) {
      root.innerHTML = `<div class="empty-state" style="padding:26px 10px">
        <div class="empty-ico" style="width:40px;height:40px;border-radius:11px">${AG.ui.icon('activity')}</div>
        <h3 style="font-size:12px">Sin eventos todavía</h3>
        <p style="font-size:10.5px">Las acciones, menús y resultados aparecerán aquí.</p>
      </div>`;
      AG.ui.icons(root);
      return;
    }
    const iconByType = {
      success: 'check-circle-2', error: 'alert-circle', warn: 'alert-triangle',
      info: 'info', session: 'terminal', action: 'mouse-pointer-click', scan: 'radar', auth: 'key-round',
    };
    const allowedTypes = new Set(['success', 'error', 'warn', 'info', 'session', 'action', 'scan', 'auth']);
    root.innerHTML = list.map((ev) => `
      <div class="event-row ${allowedTypes.has(ev.type) ? ev.type : 'info'}">
        ${AG.ui.icon(iconByType[ev.type] || 'circle')}
        <span class="ev-time">${AG.ui.clockTime(ev.ts)}</span>
        <span class="ev-msg">${AG.ui.esc(ev.message)}${ev.detail ? `<br><span style="color:var(--tx-3);font-size:9.5px">${AG.ui.esc(ev.detail)}</span>` : ''}</span>
      </div>`).join('');
    AG.ui.icons(root);
  }

  function setTheme(mode) {
    if (!term) return;
    try { term.options.theme = themeFor(mode); } catch {}
  }

  return {
    init, fit, open, close, toggle, isOpen, switchTab,
    write, reset, clear, getLog, getTerm, getScreen, scrollToBottom,
    focus, blur, setStatus, renderEvents, setTheme,
    setFontSize, getFontSize, showSearch, hideSearch,
    maximize, isMaximized, copySelection,
    addSystemLog, setSystemLogs,
  };
})();