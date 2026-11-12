'use strict';

window.AG = window.AG || {};

AG.app = (() => {
  const { $, esc, icon, toast, setHTML } = AG.ui;

  const VIEW_META = {
    dashboard: { title: 'Panel', crumb: 'Panel', icon: 'layout-dashboard' },
    audits: { title: 'Auditorías', crumb: 'Auditorías', icon: 'shield-half' },
    networks: { title: 'Redes', crumb: 'Redes', icon: 'radar' },
    interfaces: { title: 'Interfaces', crumb: 'Interfaces', icon: 'network' },
    history: { title: 'Historial', crumb: 'Historial', icon: 'history' },
    config: { title: 'Configuración', crumb: 'Configuración', icon: 'sliders-horizontal' },
    diagnostics: { title: 'Diagnóstico', crumb: 'Diagnóstico', icon: 'stethoscope' },
  };

  const state = {
    view: 'dashboard',
    netSortKey: 'signal',
    netSortDir: 'desc',
    netViewMode: 'table',
    netFavorites: [],
    netMinSignal: 0,
    netBandFilter: 'all',
    configSearch: '',
    historySearch: '',
    historyFilterType: 'all',
    auditNotes: {},
    auditProgress: {},
    auditTemplates: [],
    scanHistory: [],
    backgroundScan: false,
    info: null,
    airgeddonVersion: '—',
    sudo: { passwordless: false, authenticated: false },
    interfaces: [],
    scan: { running: false, iface: null, band: 'abg', aps: [], stations: [], updatedAt: 0 },
    scanIface: '',
    scanBand: 'abg',
    netFilter: '',
    captures: [],
    diagnostics: null,
    config: {},
    events: [],
    session: { running: false, startedAt: null, exitCode: null },
    prompt: null,
    queue: [],
    interactionMode: 'assistant',
    suppressPasswordUntil: 0,
    ws: null,
    wsReady: false,
    reconnectTimer: null,
    pendingSudo: null,
    booted: false,
    managedMonitorInterfaces: new Set(),
  };

  let parseTimer = null;
  let lastScanRender = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  // ── Eventos internos ──────────────────────────────────────────────────────

  function addEvent(type, message, detail = '') {
    state.events.unshift({ type, message, detail, ts: Date.now() });
    if (state.events.length > 300) state.events.length = 300;
    AG.terminal.renderEvents(state.events);
    if (state.view === 'dashboard' || state.view === 'history') renderView();
  }

  function updateSudoUI() {
    const dot = $('#sudoDot');
    const title = $('#sudoTitle');
    const sub = $('#sudoSub');
    if (!dot) return;
    dot.classList.remove('on', 'warn', 'off');
    if (state.sudo.passwordless) {
      dot.classList.add('on');
      title.textContent = 'sudo sin contraseña';
      sub.textContent = 'Permisos listos';
    } else if (state.sudo.authenticated) {
      dot.classList.add('on');
      title.textContent = 'sudo desbloqueado';
      sub.textContent = 'Sesión autenticada';
    } else {
      dot.classList.add('warn');
      title.textContent = 'sudo bloqueado';
      sub.textContent = 'Haz clic para autenticar';
    }
  }

  function updateTitleBadge() {
    const base = 'airgeddon GUI';
    const pending = state.prompt ? 1 : 0;
    const running = state.session && state.session.running;
    if (pending) document.title = `(${pending}) ${base}`;
    else if (running) document.title = `● ${base}`;
    else document.title = base;
  }

  function updateSessionUI() {
    const running = Boolean(state.session.running);
    const waiting = Boolean(state.prompt);

    const pill = $('#sessionPill');
    const pillDot = $('#pillDot');
    const pillText = $('#pillText');
    if (pill && pillDot && pillText) {
      pill.classList.toggle('running', running && !waiting);
      pill.classList.toggle('waiting', waiting);
      pillDot.classList.remove('on', 'warn', 'off');
      pillDot.classList.add(waiting ? 'warn' : running ? 'on' : 'off');
      pillText.textContent = waiting ? 'Esperando respuesta' : running ? 'Sesión activa' : 'Sin sesión';
    }

    const sbDot = $('#sbDot');
    const sbStatus = $('#sbStatus');
    if (sbDot && sbStatus) {
      sbDot.classList.remove('on', 'warn', 'off');
      sbDot.classList.add(running ? 'on' : 'off');
      sbStatus.textContent = running ? (waiting ? 'Esperando acción' : 'airgeddon en marcha') : 'Sin sesión';
    }

    const pending = $('#pendingPill');
    const pendingLabel = $('#pendingLabel');
    if (pending && pendingLabel) {
      // La píldora sirve para reabrir el asistente cuando la ventana está
      // oculta (modo consola o cierre manual).
      const modalOpen = AG.interaction && typeof AG.interaction.isOpen === 'function' && AG.interaction.isOpen();
      const pendingVisible = waiting && !modalOpen;
      pending.classList.toggle('hidden', !pendingVisible);
      if (pendingVisible && state.prompt) {
        pendingLabel.textContent = state.prompt.context?.name || state.prompt.title || 'Responder';
      }
    }

    const navCount = $('#navNetCount');
    if (navCount) {
      const n = (state.scan.aps || []).length;
      navCount.textContent = String(n);
      navCount.classList.toggle('hidden', n === 0);
    }

    AG.terminal.setStatus(running, waiting);
    updateTitleBadge();
    updateSudoUI();
  }

  function updateModeUI() {
    const assistant = document.getElementById('modeAssistant');
    const consoleBtn = document.getElementById('modeConsole');
    const isAssistant = state.interactionMode !== 'console';
    if (assistant) assistant.classList.toggle('active', isAssistant);
    if (consoleBtn) consoleBtn.classList.toggle('active', !isAssistant);
    const sw = document.getElementById('modeSwitch');
    if (sw) sw.dataset.mode = isAssistant ? 'assistant' : 'console';
  }

  /**
   * Cambia entre responder con ventanas (asistente) o escribir en la consola.
   * La preferencia se recuerda entre sesiones.
   */
  function setInteractionMode(mode, opts = {}) {
    const next = mode === 'console' ? 'console' : 'assistant';
    state.interactionMode = next;
    try { localStorage.setItem('ag-interaction-mode', next); } catch {}
    if (AG.interaction && typeof AG.interaction.setMode === 'function') AG.interaction.setMode(next);
    updateModeUI();

    if (next === 'assistant') {
      // Reabre la ventana pendiente si la había y estaba oculta.
      if (AG.interaction && !AG.interaction.isOpen()) {
        analyzeScreen();
        AG.interaction.forceOpen();
      }
    } else if (opts.focus !== false) {
      AG.terminal.open({ focus: true });
    }
    updateSessionUI();
  }

  function returnToAssistant() {
    setInteractionMode('assistant');
    if (AG.terminal && AG.terminal.close) {
      AG.terminal.close();
    }
    analyzeScreen();
    if (AG.interaction && AG.interaction.forceOpen) {
      const ok = AG.interaction.forceOpen();
      if (ok) {
        toast('Modo Asistente visual activado', 'success');
      } else {
        setTimeout(() => {
          analyzeScreen();
          if (AG.interaction && AG.interaction.forceOpen) {
            const reOk = AG.interaction.forceOpen();
            if (reOk) toast('Modo Asistente visual activado', 'success');
            else toast('airgeddon no requiere respuesta en este momento', 'info');
          }
        }, 260);
      }
    }
  }

  function useConsole() {
    setInteractionMode('console');
  }

  function onInteractionClosed() {
    updateSessionUI();
  }

  function renderView() {
    const el = document.getElementById(`view-${state.view}`);
    if (!el) return;
    el.innerHTML = AG.views.render(state.view, state);
    AG.ui.icons(el);
  }

  function renderLive() {
    if (state.view === 'networks') {
      const ae = document.activeElement;
      if (ae && ae.tagName === 'INPUT' && ae.closest && ae.closest('#view-networks')) return;
    }
    renderView();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = (window.AG && AG.api && typeof AG.api.csrfToken === 'function') ? AG.api.csrfToken() : '';
    const wsUrl = `${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { scheduleReconnect(); return; }
    state.ws = ws;

    ws.onopen = () => {
      state.wsReady = true;
      reconnectAttempts = 0;
      wsSend({ type: 'replay' });
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleWs(msg);
    };

    ws.onclose = () => {
      state.wsReady = false;
      state.ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => { state.wsReady = false; };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function wsSend(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    try { state.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function handleWs(msg) {
    switch (msg.type) {
      case 'hello':
        if (msg.session) state.session = msg.session;
        if (msg.scan) state.scan = { ...state.scan, running: Boolean(msg.scan.running), iface: msg.scan.iface || state.scan.iface };
        if (msg.sudo) state.sudo.authenticated = Boolean(msg.sudo.authenticated) || state.sudo.authenticated;
        if (Array.isArray(msg.systemLogs) && AG.terminal && AG.terminal.setSystemLogs) {
          AG.terminal.setSystemLogs(msg.systemLogs);
        }
        updateSessionUI();
        if (state.session.running && state.interactionMode === 'console') {
          AG.terminal.open();
          scheduleParse(400);
        } else if (state.session.running) {
          scheduleParse(400);
        }
        break;

      case 'sys-log':
        if (msg.log && AG.terminal && AG.terminal.addSystemLog) {
          AG.terminal.addSystemLog(msg.log);
        }
        break;

      case 'output':
        if (typeof msg.data === 'string') {
          AG.terminal.write(msg.data);
          scheduleParse();
        }
        break;

      case 'replay':
        if (typeof msg.data === 'string' && msg.data) {
          AG.terminal.reset();
          AG.terminal.write(msg.data);
          scheduleParse(200);
        }
        break;

      case 'started': {
        AG.ui.notify('airgeddon iniciado', 'La sesión de auditoría está en marcha.', '');
        // El servidor emite "started" por difusión y como respuesta directa;
        // el evento de historial solo se registra una vez.
        const wasRunning = state.session.running;
        state.session.running = true;
        state.session.startedAt = msg.startedAt || Date.now();
        if (state.interactionMode === 'console') {
          AG.terminal.open();
        }
        updateSessionUI();
        if (!wasRunning) addEvent('session', 'Sesión de airgeddon iniciada', 'Modo asistente activo.');
        scheduleParse(700);
        break;
      }

      case 'exit':
        state.session.running = false;
        state.session.exitCode = msg.code;
        setPrompt(null);
        updateSessionUI();
        addEvent(msg.code === 0 ? 'success' : 'warn', 'Sesión de airgeddon finalizada', `Código de salida: ${msg.code}`);
        AG.ui.notify('airgeddon finalizado', 'La sesión terminó con código ' + msg.code + '.');
        toast(msg.code === 0 ? 'airgeddon terminó correctamente' : `airgeddon terminó con código ${msg.code}`, msg.code === 0 ? 'success' : 'warn');
        break;

      case 'session':
        if (msg.session) {
          state.session = msg.session;
          if (!state.session.running) setPrompt(null);
          updateSessionUI();
        }
        break;

      case 'scan':
        if (msg.scan) {
          const prevCount = (state.scan.aps || []).length;
          state.scan = { ...state.scan, ...msg.scan };
          const newCount = (state.scan.aps || []).length;
          if (newCount > prevCount && newCount - prevCount >= 3) {
            AG.ui.notify('Nuevas redes detectadas', 'Se encontraron ' + newCount + ' redes en total.');
          }
          updateSessionUI();
          if (Date.now() - lastScanRender > 900) {
            lastScanRender = Date.now();
            renderLive();
          }
        }
        break;

      case 'scan-status':
        state.scan.running = Boolean(msg.running);
        if (msg.iface) state.scan.iface = msg.iface;
        state.scan.error = msg.error || null;
        if (!msg.running && (state.scan.aps || []).length > 0) {
          const entry = { ts: Date.now(), iface: state.scan.iface, count: (state.scan.aps || []).length };
          state.scanHistory.unshift(entry);
          if (state.scanHistory.length > 20) state.scanHistory.length = 20;
          localStorage.setItem('ag-scan-history', JSON.stringify(state.scanHistory));
        }
        if (msg.error) {
          addEvent('error', 'El escaneo se detuvo', msg.error);
          toast(msg.error, 'error');
        } else if (msg.running) {
          addEvent('scan', `Escaneo iniciado en ${msg.iface || state.scan.iface}`, 'airodump-ng está capturando redes.');
        } else {
          addEvent('info', 'Escaneo detenido', '');
        }
        updateSessionUI();
        renderLive();
        break;

      case 'error':
        if (msg.code === 'AUTH_REQUIRED') {
          state.sudo.authenticated = false;
          updateSudoUI();
          toast('Necesitas autenticarte con sudo', 'warn');
          openAuthModal();
        } else {
          toast(msg.message || 'Error de la sesión', 'error');
          addEvent('error', msg.message || 'Error de la sesión', msg.code || '');
        }
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  // ── Parser / asistente ────────────────────────────────────────────────────

  function scheduleParse(delay = 140) {
    if (parseTimer) return;
    parseTimer = setTimeout(() => {
      parseTimer = null;
      analyzeScreen();
    }, delay);
  }

  function reanalyzeSoon(ms = 700) {
    setTimeout(() => analyzeScreen(), Math.max(200, Number(ms) || 700));
  }

  function analyzeScreen() {
    if (!state.session.running) { setPrompt(null); return; }
    let prompt = null;
    try {
      prompt = AG.parser.analyze(AG.terminal.getScreen());
    } catch { prompt = null; }

    if (prompt && prompt.type === 'password') {
      // El backend ya envió la contraseña al PTY; evita un modal duplicado.
      if (Date.now() < state.suppressPasswordUntil || state.sudo.passwordless) prompt = null;
    }
    setPrompt(prompt);
  }

  function setPrompt(prompt) {
    const prev = state.prompt ? state.prompt.signature : null;
    state.prompt = prompt;
    AG.interaction.update(prompt);
    updateSessionUI();
    if (prompt && prompt.signature !== prev && state.view === 'dashboard') renderView();
    if (prompt && prompt.type === 'menu') flushQueue();
  }

  function flushQueue() {
    if (!state.queue.length || !state.session.running) return;
    if (!state.prompt || state.prompt.type !== 'menu') return;
    // Solo se encola para el menú principal: así una acción elegida antes de
    // arrancar no se envía por error a un menú de idioma o de interfaz.
    if (!state.prompt.context || state.prompt.context.id !== 'main') return;
    const data = state.queue.shift();
    setTimeout(() => sendInput(`${data}\n`), 380);
  }

  // ── Entrada hacia airgeddon ───────────────────────────────────────────────

  function sendInput(data) {
    if (!state.session.running) {
      toast('Inicia una sesión de airgeddon primero', 'warn');
      return false;
    }
    if (!wsSend({ type: 'input', data })) {
      toast('Sin conexión con el servidor local', 'error');
      return false;
    }
    return true;
  }

  function terminalInput(data) {
    if (!state.session.running) return;
    wsSend({ type: 'input', data });
  }

  function terminalResize(cols, rows) {
    wsSend({ type: 'resize', cols, rows });
  }

  function focusTerminal() {
    AG.terminal.open({ focus: true });
  }

  function confirmDestructive(item) {
    return AG.ui.confirm({
      title: 'Salir de airgeddon',
      message: `¿Seguro que quieres ${item && (item.title || item.text) ? String(item.title || item.text).toLowerCase() : 'salir'}?`,
      detail: 'Se cerrará la sesión actual y volverás a la GUI.',
      danger: true,
      confirmLabel: 'Salir',
      icon: 'log-out',
    });
  }

  // ── Sesión y sudo ─────────────────────────────────────────────────────────

  function requireSudo(fn) {
    if (state.sudo.authenticated || state.sudo.passwordless) { fn(); return; }
    state.pendingSudo = fn;
    openAuthModal();
  }

  async function startSession() {
    if (state.session.running) { toast('La sesión ya está en marcha', 'info'); return; }
    // airgeddon y el escáner nativo compiten por la misma interfaz en modo
    // monitor: se detiene el escaneo antes de lanzar la sesión.
    if (state.scan.running) await stopScan();
    // Intentar matar procesos colgados de sesiones anteriores
    try {
      await AG.api.post('/api/interfaces/kill');
      await refreshInterfaces();
    } catch {}
    requireSudo(() => {
      state.suppressPasswordUntil = Date.now() + 6000;
      if (state.interactionMode === 'console') {
        AG.terminal.open();
      }
      const term = AG.terminal.getTerm();
      if (!wsSend({ type: 'start', cols: term ? term.cols : 120, rows: term ? term.rows : 40 })) {
        toast('Sin conexión con el servidor local', 'error');
        return;
      }
      addEvent('session', 'Iniciando airgeddon…', 'Preparando la sesión PTY.');
    });
  }

  async function stopSession() {
    if (!state.session.running) return;
    const ok = await AG.ui.confirm({
      title: 'Detener sesión',
      message: '¿Quieres detener airgeddon y cerrar la sesión actual?',
      detail: 'Se enviará Ctrl+C y se cerrará el proceso.',
      danger: true,
      confirmLabel: 'Detener',
      icon: 'square',
    });
    if (!ok) return;
    wsSend({ type: 'stop' });
    addEvent('warn', 'Deteniendo sesión de airgeddon…', '');
    toast('Deteniendo sesión…', 'warn');
  }

  function openAuthModal() {
    if (state.sudo.passwordless) {
      toast('sudo no requiere contraseña en este equipo', 'success');
      return;
    }
    if (state.sudo.authenticated) {
      const handle = AG.ui.modal({
        size: 'narrow',
        title: 'sudo desbloqueado',
        subtitle: 'Los permisos de administrador están activos para esta sesión de la GUI.',
        icon: 'shield-check',
        color: 'green',
        kicker: 'Permisos',
        body: `<div class="detail-note" style="border-color:var(--green-soft);background:var(--green-soft)">${icon('info')}
          <div>La contraseña solo se guarda en la memoria del servidor local. Puedes bloquearla cuando termines.</div></div>`,
        footer: `<div class="modal-actions">
            <button class="btn btn-ghost" data-close>Volver</button>
            <button class="btn btn-danger" data-lock>${icon('lock')} Bloquear sudo</button>
          </div>`,
        onMount: (h) => {
          h.el.querySelector('[data-close]').addEventListener('click', () => h.close());
          h.el.querySelector('[data-lock]').addEventListener('click', async () => {
            try {
              await AG.api.post('/api/lock');
              state.sudo.authenticated = false;
              updateSudoUI();
              h.close();
              toast('sudo bloqueado', 'info');
              addEvent('auth', 'sudo bloqueado', 'La contraseña se eliminó de la memoria del servidor.');
            } catch (err) { handleApiError(err); }
          });
        },
      });
      return;
    }

    const handle = AG.ui.modal({
      size: 'narrow',
      title: 'Desbloquear sudo',
      subtitle: 'airgeddon necesita permisos de administrador para gestionar interfaces y capturar tráfico.',
      icon: 'key-round',
      color: 'amber',
      kicker: 'Autenticación',
      body: `<div class="form-block">
        <label class="form-label" for="sudoPass">Contraseña de tu usuario</label>
        <div class="pw-wrap">
          <input class="form-input mono" id="sudoPass" type="password" name="sudo_temp_session" autocomplete="new-password" data-lpignore="true" data-form-type="other" spellcheck="false" placeholder="••••••••" autofocus>
          <button class="pw-toggle" type="button" data-toggle-pw aria-label="Mostrar u ocultar">${icon('eye')}</button>
        </div>
        <p class="form-error hidden" id="sudoError">${icon('alert-circle')}<span></span></p>
        <p class="form-help">Se envía al servidor local y solo se mantiene en memoria. Nunca se escribe en disco.</p>
      </div>`,
      footer: `<div class="modal-actions">
          <button class="btn btn-ghost" data-cancel>Cancelar</button>
          <button class="btn btn-accent" data-submit>${icon('unlock')} Desbloquear</button>
        </div>`,
      onMount: (h) => {
        const input = h.el.querySelector('#sudoPass');
        const error = h.el.querySelector('#sudoError');
        const submitBtn = h.el.querySelector('[data-submit]');
        const toggle = h.el.querySelector('[data-toggle-pw]');

        toggle.addEventListener('click', () => {
          input.type = input.type === 'password' ? 'text' : 'password';
          toggle.innerHTML = icon(input.type === 'password' ? 'eye' : 'eye-off');
          AG.ui.icons(toggle);
          input.focus();
        });

        h.el.querySelector('[data-cancel]').addEventListener('click', () => h.close());

        const showError = (message) => {
          error.classList.remove('hidden');
          error.querySelector('span').textContent = message;
        };

        const submit = async () => {
          const password = input.value;
          if (!password) { showError('Escribe tu contraseña'); input.focus(); return; }
          error.classList.add('hidden');
          submitBtn.disabled = true;
          submitBtn.innerHTML = `${icon('loader-circle')} Verificando…`;
          AG.ui.icons(submitBtn);
          try {
            await AG.api.post('/api/auth', { password });
            state.sudo.authenticated = true;
            state.sudo.passwordless = false;
            updateSudoUI();
            addEvent('auth', 'sudo desbloqueado', 'Permisos de administrador disponibles.');
            toast('sudo desbloqueado', 'success');
            h.close();
            const fn = state.pendingSudo;
            state.pendingSudo = null;
            if (fn) setTimeout(fn, 220);
          } catch (err) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `${icon('unlock')} Desbloquear`;
            AG.ui.icons(submitBtn);
            showError(err.message || 'No se pudo autenticar');
            input.select();
          }
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        submitBtn.addEventListener('click', submit);
        setTimeout(() => { try { input.focus(); } catch {} }, 60);
      },
    });
    return handle;
  }

  function handleApiError(err) {
    if (!err) return;
    if (err.code === 'AUTH_REQUIRED' || err.status === 401) {
      state.sudo.authenticated = false;
      updateSudoUI();
      toast('Necesitas autenticarte con sudo', 'warn');
      openAuthModal();
      return;
    }
    toast(err.message || 'Error inesperado', 'error');
    addEvent('error', err.message || 'Error inesperado', err.code || '');
  }

  // ── Carga de datos ────────────────────────────────────────────────────────

  async function refreshSudo() {
    try {
      const s = await AG.api.get('/api/sudo/status');
      state.sudo = { passwordless: Boolean(s.passwordless), authenticated: Boolean(s.authenticated) };
      updateSudoUI();
    } catch {}
  }

  async function refreshInfo() {
    try {
      const info = await AG.api.get('/api/info');
      state.info = info;
      if (info.session) state.session = info.session;
      if (info.scan) state.scan = { ...state.scan, running: Boolean(info.scan.running), iface: info.scan.iface || null };
      updateSessionUI();
    } catch {}
  }

  async function refreshInterfaces() {
    try {
      const list = await AG.api.get('/api/interfaces');
      state.interfaces = Array.isArray(list) ? list : [];
      const selected = state.interfaces.find((i) => i.name === state.scanIface && i.wireless);
      if (!selected) {
        const mon = state.interfaces.find((i) => i.monitor);
        const wifi = state.interfaces.find((i) => i.wireless);
        state.scanIface = (mon || wifi || {}).name || '';
      }
      if (['networks', 'interfaces', 'dashboard'].includes(state.view)) renderLive();
    } catch (err) { handleApiError(err); }
  }

  async function refreshCaptures() {
    try {
      const list = await AG.api.get('/api/captures');
      state.captures = Array.isArray(list) ? list : [];
      if (state.view === 'history' || state.view === 'dashboard') renderLive();
    } catch {}
  }

  async function refreshConfig() {
    try {
      const cfg = await AG.api.get('/api/config');
      state.config = cfg || {};
      if (state.view === 'config') renderView();
    } catch (err) { handleApiError(err); }
  }

  async function refreshDiagnostics() {
    try {
      const diag = await AG.api.get('/api/diagnostics');
      state.diagnostics = diag;
      if (diag && diag.airgeddon && diag.airgeddon.version) state.airgeddonVersion = diag.airgeddon.version;
      if (diag && diag.sudo) {
        state.sudo.passwordless = Boolean(diag.sudo.passwordless);
        state.sudo.authenticated = Boolean(diag.sudo.authenticated);
        updateSudoUI();
      }
      if (state.view === 'diagnostics' || state.view === 'dashboard') renderLive();
    } catch (err) { handleApiError(err); }
  }

  // ── Escaneo ───────────────────────────────────────────────────────────────

  async function ensureMonitor(name) {
    const iface = state.interfaces.find((i) => i.name === name);
    if (!iface) throw new Error('La interfaz seleccionada no existe');
    if (!iface.wireless) throw new Error('La interfaz seleccionada no es wifi');
    if (iface.monitor) return iface.name;

    await AG.api.post('/api/interfaces/monitor', { name: iface.name, action: 'start' });
    if (state.managedMonitorInterfaces) state.managedMonitorInterfaces.add(iface.name);
    const list = await AG.api.get('/api/interfaces');
    state.interfaces = Array.isArray(list) ? list : [];
    const mon = state.interfaces.find((i) => i.monitor);
    if (!mon) throw new Error('No se pudo activar el modo monitor');
    state.scanIface = mon.name;
    return mon.name;
  }

  function startScan(background) {
    if (state.session.running && !background) {
      toast('Detén la sesión de airgeddon antes de lanzar un escaneo nativo', 'warn');
      return;
    }
    state.backgroundScan = !!background;
    const selected = state.scanIface || (state.interfaces.find((i) => i.monitor) || {}).name || (state.interfaces.find((i) => i.wireless) || {}).name;
    if (!selected) {
      toast('No hay ninguna interfaz wifi disponible', 'warn');
      setView('interfaces');
      return;
    }
    const ifaceObj = state.interfaces.find((i) => i.name === selected) || state.interfaces.find((i) => i.wireless);

    requireSudo(async () => {
      try {
        let targetIface = selected;
        if (ifaceObj && !ifaceObj.monitor) {
          const ok = await AG.ui.confirm({
            title: 'Activar Modo Monitor',
            message: `La interfaz "${ifaceObj.name}" está actualmente en modo Managed (cliente).`,
            detail: 'Para un escaneo verídico que detecte paquetes 802.11 y las estaciones/clientes reales con airodump-ng, la antena debe estar en modo monitor. ¿Deseas ponerla en modo monitor ahora?',
            icon: 'radio',
            confirmLabel: 'Activar modo monitor e iniciar',
            cancelLabel: 'Cancelar',
          });
          if (!ok) return;
          toast('Poniendo antena en modo monitor…', 'info');
          targetIface = await ensureMonitor(ifaceObj.name);
        }
        toast('Iniciando airodump-ng…', 'info');
        const snap = await AG.api.post('/api/scan/start', { interface: targetIface, band: state.scanBand || 'abg' });
        state.scan = { ...state.scan, ...snap };
        toast(`Escaneando con ${targetIface}`, 'success');
        renderLive();
      } catch (err) { handleApiError(err); }
    });
  }

  async function stopScan() {
    try {
      const scanIface = state.scan.iface || state.scanIface;
      await AG.api.post('/api/scan/stop');
      state.scan.running = false;
      addEvent('info', 'Escaneo detenido', '');
      toast('Escaneo detenido', 'info');
      await refreshInterfaces();
      renderLive();

      // Comprobar si la interfaz utilizada (o alguna interfaz inalámbrica) quedó en modo monitor
      const monIface = state.interfaces.find((i) => (i.name === scanIface && i.monitor) || (i.wireless && i.monitor));
      if (monIface) {
        const revert = await AG.ui.confirm({
          title: '¿Volver a Modo Managed (Normal)?',
          message: `El escaneo se ha detenido. La interfaz "${monIface.name}" continúa en modo monitor.`,
          detail: '¿Deseas devolver la tarjeta a modo Managed (modo cliente normal) para restablecer la conexión wifi habitual de tu sistema, o prefieres mantenerla en modo monitor?',
          icon: 'radio',
          color: 'teal',
          confirmLabel: 'Volver a modo Managed',
          cancelLabel: 'Mantener en modo monitor',
        });
        if (revert) {
          await toggleMonitor(monIface.name, 'stop');
        }
      }
    } catch (err) { handleApiError(err); }
  }

  async function toggleMonitor(name, op) {
    requireSudo(async () => {
      try {
        toast(op === 'start' ? 'Activando modo monitor…' : 'Volviendo a modo managed…', 'info');
        const res = await AG.api.post('/api/interfaces/monitor', { name, action: op });
        if (state.managedMonitorInterfaces) {
          if (op === 'start') state.managedMonitorInterfaces.add(name);
          else state.managedMonitorInterfaces.delete(name);
        }
        if (res && Array.isArray(res.interfaces)) state.interfaces = res.interfaces;
        else await refreshInterfaces();
        addEvent('action', op === 'start' ? `Modo monitor activado en ${name}` : `Modo managed en ${name}`, '');
        toast(op === 'start' ? 'Modo monitor activado' : 'Interfaz en modo managed', 'success');
        renderLive();
      } catch (err) { handleApiError(err); }
    });
  }

  async function killProcesses() {
    requireSudo(async () => {
      try {
        const res = await AG.api.post('/api/interfaces/kill');
        if (res && Array.isArray(res.interfaces)) state.interfaces = res.interfaces;
        else await refreshInterfaces();
        addEvent('action', 'Procesos de red detenidos', 'airmon-ng check kill');
        toast('Procesos detenidos', 'success');
        renderLive();
      } catch (err) { handleApiError(err); }
    });
  }

  // ── Auditorías y acciones ─────────────────────────────────────────────────

  function sendMainKey(key, title) {
    if (!state.session.running) {
      state.queue.push(String(key));
      startSession();
      toast(`Se abrirá “${title}” al iniciar airgeddon`, 'info');
      return;
    }
    if (state.prompt && state.prompt.type === 'menu' && state.prompt.context && state.prompt.context.id === 'main') {
      sendInput(`${key}\n`);
      addEvent('action', `Acción: ${title}`, '');
      return;
    }
    if (!state.prompt) {
      state.queue.push(String(key));
      toast('Se enviará cuando airgeddon esté listo', 'info');
      return;
    }
    toast('Termina la interacción actual o vuelve al menú principal', 'warn');
  }

  function startAudit(id) {
    const audit = (AG.data.audits || []).find((a) => a.id === id);
    if (!audit) return;
    sendMainKey(audit.key, audit.title);
  }

  function openAuditGuide(id) {
    const audit = (AG.data.audits || []).find((a) => a.id === id);
    if (!audit) return;
    const handle = AG.ui.modal({
      title: audit.title,
      subtitle: audit.subtitle,
      icon: audit.icon,
      color: audit.color,
      kicker: 'Guía de auditoría',
      body: `<p style="font-size:12.5px;line-height:1.6;color:var(--tx-2)">${esc(audit.desc)}</p>
        ${AG.views ? '' : ''}
        <div class="section-title" style="margin-top:18px">${icon('list-ordered')}<span>Pasos</span></div>
        <div class="detail-list">${(audit.steps || []).map((s, i) => `<div class="detail-row"><span class="detail-n">${i + 1}</span><span>${esc(s)}</span></div>`).join('')}</div>
        ${audit.note ? `<div class="detail-note" style="margin-top:16px">${icon('alert-triangle')}<div>${esc(audit.note)}</div></div>` : ''}`,
      footer: `<div class="modal-hint">${icon('info')} Sigue los pasos en orden</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close>${icon('x')} Cerrar</button>
          <button class="btn btn-accent" data-start>${icon('play')} Iniciar auditoría</button>
        </div>`,
      onMount: (h) => {
        h.el.querySelector('[data-close]').addEventListener('click', () => h.close());
        h.el.querySelector('[data-start]').addEventListener('click', () => {
          h.close();
          startAudit(audit.id);
        });
      },
    });
    return handle;
  }

  // ── Redes ─────────────────────────────────────────────────────────────────

  function findAp(bssid) {
    return (state.scan.aps || []).find((a) => a.bssid === bssid);
  }

  function openNetworkModal(bssid, opts = {}) {
    const ap = findAp(bssid);
    if (!ap) { toast('La red ya no está en la lista', 'warn'); return; }
    const prompt = state.prompt;
    const netEntry = prompt && prompt.type === 'network' ? (prompt.nets || []).find((n) => n.bssid === bssid) : null;

    const handle = AG.ui.modal({
      title: ap.essid,
      subtitle: `${ap.bssid} · canal ${ap.channel}${ap.band && ap.band !== '—' ? ` · ${ap.band}` : ''}`,
      icon: 'wifi',
      color: ap.securityKind === 'wpa3' ? 'blue' : ap.securityKind === 'wep' ? 'red' : 'teal',
      kicker: 'Red detectada',
      body: `
        <div class="kv-grid">
          <div class="kv"><span>BSSID</span><strong>${esc(ap.bssid)}</strong></div>
          <div class="kv"><span>Canal / banda</span><strong>${esc(ap.channel)} · ${esc(ap.band || '—')}</strong></div>
          <div class="kv"><span>Seguridad</span><strong>${esc(ap.security)}${ap.cipher ? ` · ${esc(ap.cipher)}` : ''}</strong></div>
          <div class="kv"><span>Señal</span><strong>${esc(ap.signal)}% (${esc(ap.power)} dBm)</strong></div>
          <div class="kv"><span>Clientes</span><strong>${esc(ap.clients || 0)}</strong></div>
          <div class="kv"><span>Beacons</span><strong>${esc(ap.beacons || 0)}</strong></div>
        </div>
        ${ap.stations && ap.stations.length ? `
          <div class="stations-box" style="margin-top:14px">
            <div class="stations-title">${icon('users')} Estaciones / Dispositivos conectados (${ap.stations.length})</div>
            <table class="stations-table">
              <thead>
                <tr>
                  <th>STATION MAC</th>
                  <th>PWR</th>
                  <th>PAQUETES</th>
                  <th>PROBES</th>
                </tr>
              </thead>
              <tbody>
                ${ap.stations.map((st) => `
                  <tr>
                    <td class="station-mac">${esc(st.mac)}</td>
                    <td>${st.power ? `${st.power} dBm` : '—'}</td>
                    <td>${esc(st.packets || 0)}</td>
                    <td class="station-probes">${esc(st.probed || '(asociado)')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}
        <div class="detail-note" style="margin-top:16px">${icon('info')}
          <div>${netEntry
            ? 'Esta red está en la lista de selección de airgeddon. Puedes elegirla directamente.'
            : 'Para auditarla, inicia el flujo Handshake/PMKID y selecciónala cuando airgeddon muestre la lista de objetivos.'}</div>
        </div>`,
      footer: `<div class="modal-actions">
          <button class="btn btn-ghost" data-copy>${icon('copy')} Copiar BSSID</button>
          ${netEntry ? `<button class="btn btn-soft" data-select>${icon('crosshair')} Seleccionar en airgeddon</button>` : ''}
          <button class="btn btn-accent" data-audit>${icon('key-round')} Auditar handshake</button>
        </div>`,
      onMount: (h) => {
        h.el.querySelector('[data-copy]').addEventListener('click', async () => {
          const ok = await AG.ui.copyText(ap.bssid);
          toast(ok ? 'BSSID copiado' : 'No se pudo copiar', ok ? 'success' : 'error');
        });
        const selectBtn = h.el.querySelector('[data-select]');
        if (selectBtn) {
          selectBtn.addEventListener('click', () => {
            const answered = AG.interaction.respond(String(netEntry.n));
            if (!answered) sendInput(`${netEntry.n}\n`);
            h.close();
            toast(`Objetivo seleccionado: ${ap.essid}`, 'success');
            addEvent('action', `Objetivo seleccionado: ${ap.essid}`, ap.bssid);
            setPrompt(null);
          });
        }
        h.el.querySelector('[data-audit]').addEventListener('click', () => {
          h.close();
          startAudit('handshake');
        });
      },
    });
    return handle;
  }

  // ── Configuración ─────────────────────────────────────────────────────────

  async function saveConfig(key, value) {
    // Validate boolean values
    const def = (AG.data.configDefs || []).find(function(d) { return d.key === key; });
    if (def && def.type === 'bool') {
      if (value !== 'true' && value !== 'false') {
        toast('Valor inválido: debe ser true o false', 'error');
        return;
      }
    }
    if (def && def.type === 'select' && def.options) {
      if (!def.options.includes(value)) {
        toast('Valor no válido para esta opción', 'error');
        return;
      }
    }
    try {
      await AG.api.post('/api/config', { key, value });
      state.config[key] = value;
      toast('Configuración guardada', 'success');
      if (state.view === 'config') renderView();
    } catch (err) { handleApiError(err); }
  }

  async function openConfigRaw() {
    try {
      const data = await AG.api.get('/api/config/raw');
      const handle = AG.ui.modal({
        size: 'wide',
        title: 'Archivo .airgeddonrc',
        subtitle: 'Edita el archivo completo. Se crea una copia de seguridad antes de guardar.',
        icon: 'file-code',
        color: 'slate',
        kicker: 'Configuración avanzada',
        body: `<textarea class="raw-editor" id="rawConfig" spellcheck="false">${esc(data.content || '')}</textarea>
          <p class="form-error hidden" id="rawError">${icon('alert-circle')}<span></span></p>`,
        footer: `<div class="modal-hint">${icon('info')} Los cambios se aplican al reiniciar airgeddon</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-close>Cancelar</button>
            <button class="btn btn-accent" data-save>${icon('save')} Guardar archivo</button>
          </div>`,
        onMount: (h) => {
          const area = h.el.querySelector('#rawConfig');
          const error = h.el.querySelector('#rawError');
          h.el.querySelector('[data-close]').addEventListener('click', () => h.close());
          h.el.querySelector('[data-save]').addEventListener('click', async () => {
            try {
              await AG.api.put('/api/config/raw', { content: area.value });
              await refreshConfig();
              addEvent('action', 'Archivo .airgeddonrc actualizado', '');
              toast('Configuración guardada', 'success');
              h.close();
            } catch (err) {
              error.classList.remove('hidden');
              error.querySelector('span').textContent = err.message || 'No se pudo guardar';
            }
          });
        },
      });
      return handle;
    } catch (err) { handleApiError(err); }
  }

  // ── Navegación y tema ─────────────────────────────────────────────────────

  function setView(name) {
    if (!VIEW_META[name]) name = 'dashboard';
    state.view = name;
    document.querySelectorAll('.view').forEach((el) => {
      el.classList.toggle('hidden', el.id !== `view-${name}`);
    });
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === name);
    });

    const meta = VIEW_META[name];
    const title = $('#pageTitle');
    const crumb = $('#breadcrumb');
    if (title) title.textContent = meta.title;
    if (crumb) {
      crumb.innerHTML = `<span class="crumb">${icon('radar')} airgeddon</span>
        <span class="sep">/</span>
        <span class="crumb">${icon(meta.icon)} ${esc(meta.crumb)}</span>`;
      AG.ui.icons(crumb);
    }

    if (name === 'networks') refreshInterfaces();
    if (name === 'config' && !Object.keys(state.config).length) refreshConfig();
    if (name === 'diagnostics' && !state.diagnostics) refreshDiagnostics();
    if (name === 'history') refreshCaptures();

    renderView();
    $('#viewScroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const THEMES = ['dark', 'light'];
  const THEME_ICONS = { dark: 'sun', light: 'moon' };
  const THEME_LABELS = { dark: 'Oscuro', light: 'Claro' };

  function setTheme(mode) {
    const next = THEMES.includes(mode) ? mode : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ag-theme', next);
    AG.terminal.setTheme(next);
    const btn = $('#themeBtn');
    if (btn) {
      btn.innerHTML = icon(THEME_ICONS[next] || 'sun');
      btn.title = `Tema: ${THEME_LABELS[next] || next} (clic para cambiar)`;
      AG.ui.icons(btn);
    }
  }

  function cycleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const idx = THEMES.indexOf(current);
    const next = THEMES[(idx + 1) % THEMES.length];
    setTheme(next);
    AG.ui.toast(`Tema: ${THEME_LABELS[next]}`, 'info');
  }

  function applyNetFilter() {
    const q = (state.netFilter || '').toLowerCase();
    const rows = document.querySelectorAll('#view-networks tbody tr');
    let visible = 0;
    rows.forEach((tr) => {
      const match = !q || tr.textContent.toLowerCase().includes(q);
      tr.classList.toggle('hidden', !match);
      if (match) visible += 1;
    });
    const badge = document.querySelector('#view-networks .toolbar .badge.teal');
    if (badge) badge.textContent = `${visible} redes`;
  }

  function updateSidebarUI() {
    const app = $('#app');
    const collapsed = Boolean(app?.classList.contains('sidebar-collapsed'));
    const btn = $('#sbCollapse');
    const topBtn = $('#sidebarToggle');
    if (btn) {
      btn.innerHTML = icon(collapsed ? 'panel-left-open' : 'panel-left-close');
      btn.title = collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral';
      AG.ui.icons(btn);
    }
    if (topBtn) {
      topBtn.classList.toggle('active', !collapsed);
      topBtn.title = collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral';
    }
  }

  // ── Eventos de UI ─────────────────────────────────────────────────────────

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;

      switch (action) {
        case 'switch-view':
          e.preventDefault();
          setView(target.dataset.view);
          break;

        case 'toggle-sidebar': {
          const app = $('#app');
          app?.classList.toggle('sidebar-collapsed');
          localStorage.setItem('ag-sidebar', app?.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
          updateSidebarUI();
          setTimeout(() => AG.terminal.fit(), 260);
          break;
        }

        case 'toggle-mobile':
          $('#app')?.classList.toggle('mobile-open');
          break;

        case 'toggle-theme':
          cycleTheme();
          break;

        case 'toggle-console':
          AG.terminal.toggle();
          break;

        case 'console-scroll':
          AG.terminal.scrollToBottom();
          break;

        case 'console-clear':
          AG.terminal.clear();
          toast('Consola limpiada', 'info');
          break;

        case 'console-maximize':
          AG.terminal.maximize();
          break;

        case 'console-copy-sel':
          AG.terminal.copySelection();
          break;

        case 'console-download': {
          const log = AG.terminal.getLog();
          if (!log) { toast('Todavía no hay salida que descargar', 'warn'); break; }
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          AG.ui.download(`airgeddon-${stamp}.log`, log);
          toast('Log descargado', 'success');
          break;
        }

        case 'auth-open':
          openAuthModal();
          break;

        case 'session-start':
          startSession();
          break;

        case 'session-stop':
          stopSession();
          break;

        case 'open-prompt':
        case 'mode-assistant':
        case 'return-assistant':
          returnToAssistant();
          break;

        case 'mode-console':
          setInteractionMode('console');
          break;

        case 'main-action':
          if (String(target.dataset.key) === '0') {
            confirmDestructive({ title: 'salir de airgeddon' }).then((ok) => {
              if (ok) sendMainKey('0', 'Salir');
            });
          } else {
            sendMainKey(target.dataset.key, target.dataset.title || 'Acción');
          }
          break;

        case 'start-audit':
          startAudit(target.dataset.audit);
          break;

        case 'audit-guide':
          openAuditGuide(target.dataset.audit);
          break;

        case 'audit-note': {
          // Handled via change event
          break;
        }

        case 'save-template': {
          const name = prompt('Nombre de la plantilla:');
          if (!name) break;
          const template = { name: name, notes: state.auditNotes, progress: state.auditProgress, ts: Date.now() };
          state.auditTemplates.push(template);
          localStorage.setItem('ag-audit-templates', JSON.stringify(state.auditTemplates));
          toast('Plantilla guardada', 'success');
          break;
        }

        case 'load-template': {
          if (!state.auditTemplates.length) { toast('No hay plantillas guardadas', 'warn'); break; }
          const names = state.auditTemplates.map(function(t, i) { return (i + 1) + '. ' + t.name; }).join('\n');
          const idx = prompt('Plantillas disponibles:\n' + names + '\n\nNúmero:');
          if (!idx) break;
          const i = parseInt(idx, 10) - 1;
          if (i >= 0 && i < state.auditTemplates.length) {
            const t = state.auditTemplates[i];
            state.auditNotes = t.notes || {};
            state.auditProgress = t.progress || {};
            localStorage.setItem('ag-audit-notes', JSON.stringify(state.auditNotes));
            localStorage.setItem('ag-audit-progress', JSON.stringify(state.auditProgress));
            if (state.view === 'audits') renderView();
            toast('Plantilla cargada: ' + t.name, 'success');
          }
          break;
        }

        case 'audit-progress-inc': {
          const auditId = target.dataset.audit;
          if (!auditId) break;
          const current = (state.auditProgress || {})[auditId] || 0;
          const next = Math.min(100, current + 25);
          state.auditProgress[auditId] = next;
          localStorage.setItem('ag-audit-progress', JSON.stringify(state.auditProgress));
          if (state.view === 'audits') renderView();
          toast(`Progreso: ${next}%`, 'info');
          break;
        }

        case 'goto-networks':
          setView('networks');
          break;

        case 'refresh-interfaces':
          refreshInterfaces().then(() => toast('Interfaces actualizadas', 'success'));
          break;

        case 'net-view-table':
          state.netViewMode = 'table';
          localStorage.setItem('ag-net-view', 'table');
          if (state.view === 'networks') renderView();
          break;

        case 'net-view-cards':
          state.netViewMode = 'cards';
          localStorage.setItem('ag-net-view', 'cards');
          if (state.view === 'networks') renderView();
          break;

        case 'net-fav': {
          const bssid = target.dataset.bssid;
          if (!bssid) break;
          const idx = state.netFavorites.indexOf(bssid);
          if (idx >= 0) state.netFavorites.splice(idx, 1);
          else state.netFavorites.push(bssid);
          localStorage.setItem('ag-net-favorites', JSON.stringify(state.netFavorites));
          if (state.view === 'networks') renderView();
          break;
        }

        case 'net-min-signal': {
          state.netMinSignal = parseInt(target.value || '0', 10);
          localStorage.setItem('ag-net-min-signal', String(state.netMinSignal));
          if (state.view === 'networks') renderView();
          break;
        }

        case 'net-band-filter': {
          state.netBandFilter = target.value || 'all';
          localStorage.setItem('ag-net-band-filter', state.netBandFilter);
          if (state.view === 'networks') renderView();
          break;
        }

        case 'export-csv': {
          const aps = (state.scan.aps || []);
          if (!aps.length) { toast('No hay redes para exportar', 'warn'); break; }
          const header = 'ESSID,BSSID,Channel,Band,Signal,Security,Clients';
          const rows = aps.map((ap) => `"${(ap.essid || '').replace(/"/g, '""')}","${ap.bssid || ''}",${ap.channel || ''},"${ap.band || ''}",${ap.signal || 0},"${ap.security || ''}",${ap.clients || 0}`);
          const csv = header + '\n' + rows.join('\n');
          AG.ui.download(`airgeddon-networks-${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
          toast(`${aps.length} redes exportadas a CSV`, 'success');
          break;
        }

        case 'scan-start':
          startScan();
          break;

        case 'scan-stop':
          stopScan();
          break;

        case 'iface-monitor':
          toggleMonitor(target.dataset.name, target.dataset.op);
          break;

        case 'iface-scan':
          state.scanIface = target.dataset.name;
          setView('networks');
          startScan();
          break;

        case 'iface-kill':
          killProcesses();
          break;

        case 'kill-hung': {
          requireSudo(async () => {
            try {
              toast('Matando procesos colgados...', 'info');
              await AG.api.post('/api/interfaces/kill');
              // Also try to kill any remaining airgeddon/airodump processes
              try { await AG.api.post('/api/interfaces/kill'); } catch {}
              await refreshInterfaces();
              addEvent('action', 'Procesos colgados eliminados', 'airmon-ng check kill ejecutado.');
              toast('Procesos colgados eliminados', 'success');
              renderLive();
            } catch (err) { handleApiError(err); }
          });
          break;
        }

        case 'toggle-stations': {
          e.stopPropagation();
          const bssid = target.dataset.bssid;
          if (!bssid) break;
          const id = 'stRow-' + bssid.replace(/[^a-zA-Z0-9]/g, '');
          const row = document.getElementById(id);
          if (row) {
            row.classList.toggle('hidden');
            target.classList.toggle('active');
          }
          break;
        }

        case 'toggle-stations-card': {
          e.stopPropagation();
          const bssid = target.dataset.bssid;
          if (!bssid) break;
          const id = 'stCard-' + bssid.replace(/[^a-zA-Z0-9]/g, '');
          const box = document.getElementById(id);
          if (box) {
            box.classList.toggle('hidden');
            target.classList.toggle('active');
          }
          break;
        }

        case 'network-select':
          openNetworkModal(target.dataset.bssid);
          break;

        case 'network-audit':
          openNetworkModal(target.dataset.bssid, { audit: true });
          break;

        case 'file-copy-path': {
          const path = target.dataset.path;
          if (path) {
            AG.ui.copyText(path).then(function(ok) {
              AG.ui.toast(ok ? 'Ruta copiada' : 'No se pudo copiar', ok ? 'success' : 'error');
            });
          }
          break;
        }

        case 'history-clear':
          state.events = [];
          AG.terminal.renderEvents(state.events);
          renderView();
          toast('Historial limpiado', 'info');
          break;

        case 'history-filter-type': {
          state.historyFilterType = target.value || 'all';
          if (state.view === 'history') renderView();
          break;
        }

        case 'config-refresh':
          refreshConfig().then(() => toast('Configuración recargada', 'success'));
          break;

        case 'config-raw':
          openConfigRaw();
          break;

        case 'config-export': {
          const cfg = state.config || {};
          const json = JSON.stringify(cfg, null, 2);
          AG.ui.download('airgeddon-config.json', json, 'application/json');
          toast('Configuración exportada', 'success');
          break;
        }

        case 'config-import': {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,.airgeddonrc';
          input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
              const text = await file.text();
              const data = JSON.parse(text);
              for (const [key, value] of Object.entries(data)) {
                await AG.api.post('/api/config', { key, value });
                state.config[key] = value;
              }
              await refreshConfig();
              toast('Configuración importada', 'success');
              addEvent('action', 'Configuración importada', file.name);
            } catch (err) {
              toast('Error al importar: ' + (err.message || 'archivo inválido'), 'error');
            }
          });
          input.click();
          break;
        }

        case 'config-toggle':
          if (target.dataset.key === 'SOUND') {
            const newVal = target.dataset.value;
            localStorage.setItem('ag-sound', newVal === 'off' ? 'off' : 'on');
            if (state.view === 'config') renderView();
            toast(newVal === 'off' ? 'Sonidos desactivados' : 'Sonidos activados', 'info');
            break;
          }
          saveConfig(target.dataset.key, target.dataset.value);
          break;

        case 'check-updates': {
          toast('Buscando actualizaciones...', 'info');
          const descEl = document.getElementById('update-status-desc');
          const textEl = document.getElementById('update-status-text');
          const applyBtn = document.getElementById('btn-apply-updates');
          (async () => {
            try {
              const data = await AG.api.get('/api/system/updates');
              if (data.behind > 0) {
                if (descEl) descEl.textContent = `Hay ${data.behind} actualización(es) disponible(s) en la rama ${data.branch}.`;
                if (textEl) textEl.textContent = `Commit actual: ${data.currentCommit} (${data.behind} pendientes)`;
                if (applyBtn) {
                  applyBtn.style.display = 'inline-flex';
                  applyBtn.textContent = `Actualizar ahora (${data.behind})`;
                }
                toast(`¡${data.behind} actualización(es) disponible(s)!`, 'warn');
              } else {
                if (descEl) descEl.textContent = 'airgeddon GUI está completamente actualizado.';
                if (textEl) textEl.textContent = `v${data.version} (${data.currentCommit}) · Rama ${data.branch}`;
                if (applyBtn) applyBtn.style.display = 'none';
                toast('Tu versión ya está al día', 'success');
              }
            } catch (err) {
              toast('Error al consultar actualizaciones: ' + err.message, 'error');
            }
          })();
          break;
        }

        case 'apply-updates': {
          confirmDestructive({
            title: 'actualizar airgeddon GUI a la última versión',
            confirmText: 'Actualizar ahora',
          }).then(async (ok) => {
            if (!ok) return;
            toast('Descargando e instalando actualización...', 'info');
            try {
              await AG.api.post('/api/system/updates/apply');
              toast('¡Actualización completada! Reiniciando interfaz...', 'success');
              setTimeout(() => location.reload(), 2000);
            } catch (err) {
              toast('Error en la actualización: ' + err.message, 'error');
            }
          });
          break;
        }

        case 'theme-select': {
          const theme = target.value;
          setTheme(theme);
          break;
        }

        case 'console-font-size': {
          const size = parseInt(target.value || '12', 10);
          AG.terminal.setFontSize(size);
          if (state.view === 'config') renderView();
          break;
        }

        case 'diag-refresh':
          refreshDiagnostics().then(() => toast('Diagnóstico actualizado', 'success'));
          break;

        case 'open-wireshark':
          window.open('https://www.wireshark.org/', '_blank');
          toast('Abriendo Wireshark...', 'info');
          break;

        case 'open-hashcat':
          window.open('https://hashcat.net/hashcat/', '_blank');
          toast('Abriendo Hashcat...', 'info');
          break;

        case 'open-terminal':
          AG.terminal.open({ focus: true });
          toast('Consola abierta. Escribe comandos directamente.', 'info');
          break;

        default:
          break;
      }
    });

    // Sortable table headers
    document.addEventListener('click', (e) => {
      const th = e.target.closest('th.sortable, th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (!key) return;
      if (state.netSortKey === key) {
        state.netSortDir = state.netSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.netSortKey = key;
        state.netSortDir = 'desc';
      }
      if (state.view === 'networks') renderView();
    });

    document.addEventListener('change', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.action === 'audit-note') {
        const auditId = e.target.dataset.audit;
        if (auditId) {
          state.auditNotes[auditId] = e.target.value;
          localStorage.setItem('ag-audit-notes', JSON.stringify(state.auditNotes));
        }
        return;
      }
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'scan-iface') {
        state.scanIface = el.value;
      } else if (action === 'scan-band') {
        state.scanBand = el.value;
      } else if (action === 'config-select' || action === 'config-input') {
        if (el.dataset.key) saveConfig(el.dataset.key, el.value);
      } else if (action === 'theme-select') {
        setTheme(el.value);
      } else if (action === 'console-font-size') {
        AG.terminal.setFontSize(parseInt(el.value || '12', 10));
        if (state.view === 'config') renderView();
      }
    });

    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'netFilter') {
        state.netFilter = e.target.value;
        applyNetFilter();
      }
      if (e.target && e.target.id === 'configSearch') {
        state.configSearch = e.target.value;
        if (state.view === 'config') renderView();
      }
      if (e.target && e.target.id === 'historySearch') {
        state.historySearch = e.target.value;
        if (state.view === 'history') renderView();
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) {
        e.preventDefault();
        const app = $('#app');
        app?.classList.toggle('sidebar-collapsed');
        localStorage.setItem('ag-sidebar', app?.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
        updateSidebarUI();
        setTimeout(() => AG.terminal.fit(), 260);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        AG.terminal.toggle();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        showGlobalSearch();
      }
      // View shortcuts Ctrl+1..9
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key) && !e.shiftKey) {
        const views = ['dashboard', 'audits', 'networks', 'interfaces', 'history', 'config', 'diagnostics'];
        const idx = parseInt(e.key, 10) - 1;
        if (idx < views.length) {
          e.preventDefault();
          setView(views[idx]);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && AG.terminal.isOpen()) {
        e.preventDefault();
        AG.terminal.showSearch();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+') && AG.terminal.isOpen()) {
        e.preventDefault();
        AG.terminal.setFontSize(AG.terminal.getFontSize() + 1);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-' && AG.terminal.isOpen()) {
        e.preventDefault();
        AG.terminal.setFontSize(AG.terminal.getFontSize() - 1);
      }
    });

    window.addEventListener('resize', () => setTimeout(() => AG.terminal.fit(), 120));
  }

  // ── Arranque ──────────────────────────────────────────────────────────────

  function showGlobalSearch() {
    const modal = AG.ui.modal({
      size: 'narrow',
      title: 'Búsqueda global',
      subtitle: 'Busca en redes, configuración, historial...',
      icon: 'search',
      color: 'teal',
      body: '<input class="form-input" id="globalSearchInput" type="text" placeholder="Buscar..." autofocus>',
      footer: '<div class="modal-actions"><button class="btn btn-ghost" data-close>Cerrar</button></div>',
      onMount: function(h) {
        const input = h.el.querySelector('#globalSearchInput');
        if (input) {
          input.addEventListener('input', function() {
            const q = input.value.toLowerCase();
            if (!q) return;
            // Search in config
            const cfgDefs = (AG.data.configDefs || []).filter(function(d) {
              return d.label.toLowerCase().includes(q) || d.key.toLowerCase().includes(q);
            });
            // Search in networks
            const nets = (state.scan.aps || []).filter(function(a) {
              return (a.essid || '').toLowerCase().includes(q) || (a.bssid || '').toLowerCase().includes(q);
            });
            const esc = (window.AG && AG.ui && typeof AG.ui.esc === 'function')
              ? AG.ui.esc
              : function(s) {
                  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                };
            let results = '';
            if (cfgDefs.length) {
              results += '<div class="section-title">Configuración</div>';
              results += cfgDefs.slice(0, 5).map(function(d) {
                return '<div class="search-result">' + esc(d.label) + ' (' + esc(d.key) + ')</div>';
              }).join('');
            }
            if (nets.length) {
              results += '<div class="section-title">Redes</div>';
              results += nets.slice(0, 5).map(function(n) {
                return '<div class="search-result">' + esc(n.essid || 'Sin SSID') + ' - ' + esc(n.bssid) + '</div>';
              }).join('');
            }
            if (!results) results = '<p style="color:var(--tx-3);font-size:11px">Sin resultados</p>';
            const body = h.el.querySelector('.modal-body');
            if (body) {
              const existing = body.querySelector('.search-results');
              if (existing) existing.remove();
              const div = document.createElement('div');
              div.className = 'search-results';
              div.innerHTML = results;
              body.appendChild(div);
            }
          });
        }
      },
    });
  }

  // Restore interfaces on page close (solo aquellas gestionadas por esta sesión de la GUI)
  window.addEventListener('beforeunload', () => {
    if (state.managedMonitorInterfaces && state.managedMonitorInterfaces.size > 0) {
      for (const ifaceName of state.managedMonitorInterfaces) {
        try { AG.api.post('/api/interfaces/monitor', { name: ifaceName, action: 'stop' }); } catch {}
      }
    }
  });

  function init() {
    if (state.booted) return;
    state.booted = true;

    const theme = localStorage.getItem('ag-theme') || 'dark';
    const validTheme = THEMES.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', validTheme);

    if (localStorage.getItem('ag-sidebar') === 'collapsed') $('#app')?.classList.add('sidebar-collapsed');
    updateSidebarUI();

    AG.terminal.init();
    AG.terminal.setTheme(theme);
    AG.interaction.setSender((data) => { sendInput(data); });
    state.interactionMode = 'assistant';
    try { localStorage.setItem('ag-interaction-mode', 'assistant'); } catch {}
    try { state.netFavorites = JSON.parse(localStorage.getItem('ag-net-favorites') || '[]'); } catch {} 
    state.netViewMode = localStorage.getItem('ag-net-view') || 'table';
    state.netMinSignal = parseInt(localStorage.getItem('ag-net-min-signal') || '0', 10);
    state.netBandFilter = localStorage.getItem('ag-net-band-filter') || 'all';
    try { state.auditNotes = JSON.parse(localStorage.getItem('ag-audit-notes') || '{}'); } catch {}
    try { state.auditProgress = JSON.parse(localStorage.getItem('ag-audit-progress') || '{}'); } catch {}
    try { state.auditTemplates = JSON.parse(localStorage.getItem('ag-audit-templates') || '[]'); } catch {}
    try { state.scanHistory = JSON.parse(localStorage.getItem('ag-scan-history') || '[]'); } catch {}
    AG.interaction.setMode(state.interactionMode);
    updateModeUI();
    AG.terminal.renderEvents(state.events);

    const btn = $('#themeBtn');
    if (btn) {
      btn.innerHTML = icon(THEME_ICONS[validTheme] || 'sun');
      btn.title = `Tema: ${THEME_LABELS[validTheme] || validTheme} (clic para cambiar)`;
      AG.ui.icons(btn);
    }

    bindEvents();
    setView('dashboard');
    updateSessionUI();
    updateSudoUI();
    connect();

    refreshInfo();
    refreshSudo();
    refreshInterfaces();
    refreshCaptures();
    refreshConfig();
    refreshDiagnostics();

    // Reintenta la conexión si el backend tarda en arrancar.
    setTimeout(() => { if (!state.wsReady) connect(); }, 2500);
  }

  return {
    state,
    init,
    setView,
    terminalInput,
    terminalResize,
    focusTerminal,
    reanalyzeSoon,
    confirmDestructive,
    startSession,
    startScan,
    openAuthModal,
    setInteractionMode,
    returnToAssistant,
    useConsole,
    onInteractionClosed,
    updateSessionUI,
  };
})();

document.addEventListener('DOMContentLoaded', () => AG.app.init());
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  setTimeout(() => AG.app.init(), 0);
}
