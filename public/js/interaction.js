'use strict';

window.AG = window.AG || {};

/**
 * Asistente de interacción.
 *
 * airgeddon es un script de consola: cada vez que espera una respuesta, la
 * GUI abre una ventana con las opciones disponibles para que el usuario no
 * tenga que escribir en la terminal. La consola sigue estando disponible como
 * vía alternativa (botón "Usar consola").
 */
AG.interaction = (() => {
  const { esc, icon, modal, signalBars, encClass } = AG.ui;

  let current = null;      // { signature, prompt, handle }
  let suppress = null;     // { signature, until } evita reabrir el mismo prompt
  let lastSeen = null;
  const dismissed = new Set();
  const answered = new Set();
  let sender = null;
  let mode = 'assistant';  // 'assistant' | 'console'
  let lastStartupCommitTime = 0;

  function setSender(fn) {
    sender = fn;
  }

  function setMode(next) {
    mode = next === 'console' ? 'console' : 'assistant';
    if (mode === 'console' && current) close();
    return mode;
  }

  function getMode() {
    return mode;
  }

  function send(data) {
    if (typeof sender !== 'function') return;
    try { sender(data); } catch {}
  }

  function sendLine(data) {
    send(`${data}\n`);
  }

  function isOpen() {
    return Boolean(current);
  }

  function currentPrompt() {
    return current ? current.prompt : null;
  }

  function close() {
    if (current && current.handle) {
      const handle = current.handle;
      current = null;
      handle.close(null);
    }
    current = null;
  }

  function dismiss() {
    if (current) dismissed.add(current.signature);
    close();
  }

  function rememberDismissed(signature) {
    dismissed.add(signature);
    if (dismissed.size > 40) {
      const first = dismissed.values().next().value;
      dismissed.delete(first);
    }
  }

  /**
   * Llamado por la app cada vez que la pantalla de la terminal cambia.
   * Si no hay prompt, cierra el asistente.
   */
  function update(prompt) {
    if (!prompt) {
      if (current) close();
      lastSeen = null;
      dismissed.clear();
      return;
    }

    // Una pantalla distinta invalida los descartes anteriores: si el mismo
    // menú vuelve a aparecer más tarde, debe poder abrirse de nuevo.
    if (lastSeen !== prompt.signature) {
      dismissed.clear();
      lastSeen = prompt.signature;
    }

    if (prompt.type === 'menu') {
      answered.clear();
    }

    if (current && current.signature === prompt.signature) {
      current.prompt = prompt;
      return;
    }

    // Si este prompt ya fue respondido y airgeddon aún no ha limpiado la pantalla
    // (como al escanear redes tras pulsar Enter), no se vuelve a abrir en bucle.
    if (answered.has(prompt.signature)) return;

    if (suppress) {
      if (suppress.signature === prompt.signature) {
        if (Date.now() < suppress.until) return;
        suppress = null;
      } else {
        suppress = null;
      }
    }

    if (dismissed.has(prompt.signature)) return;

    // Auto-avance de confirmaciones consecutivas de inicio de airgeddon:
    // Si el usuario ya confirmó la primera comprobación del sistema y los
    // pasos siguientes son confirmaciones normales de arranque sin error dentro
    // de una ventana de 4.5 segundos, se confirman automáticamente para evitar
    // tener que pulsar Enter repetidas veces.
    if (
      prompt.type === 'enter' &&
      (prompt.isStartup || prompt.context?.id === 'startup') &&
      !prompt.isError &&
      Date.now() - lastStartupCommitTime < 4500
    ) {
      lastStartupCommitTime = Date.now();
      commit(prompt, '', true);
      return;
    }

    // En modo consola no se abren ventanas simples, pero para selección de redes
    // SIEMPRE se abre la ventana interactiva para elegir la red con un clic.
    if (mode === 'console' && prompt.type !== 'network') {
      if (current) close();
      return;
    }

    open(prompt);
  }

  /**
   * Responde al prompt actual desde fuera (p. ej. al pulsar una red en la
   * tabla). Aplica la misma supresión que una respuesta dentro del modal.
   */
  function respond(data, closeAfter = true) {
    if (!current) return false;
    commit(current.prompt, data, closeAfter);
    return true;
  }

  function forceOpen() {
    mode = 'assistant';
    dismissed.clear();
    suppress = null;
    let prompt = (AG.app && AG.app.state && AG.app.state.prompt) || (current && current.prompt);
    if (!prompt && AG.terminal && AG.terminal.getScreen && AG.parser && AG.parser.analyze) {
      try {
        prompt = AG.parser.analyze(AG.terminal.getScreen());
        if (prompt && AG.app && AG.app.state) {
          AG.app.state.prompt = prompt;
        }
      } catch {}
    }
    if (!prompt) return false;
    open(prompt);
    return true;
  }

  function open(prompt) {
    close();
    const ctx = prompt.context || AG.parser.UNKNOWN_CONTEXT;
    const color = prompt.color || ctx.color || 'teal';
    const size = prompt.type === 'network' ? 'xlarge' : (prompt.type === 'menu' ? 'wide' : 'narrow');
    const iconName = prompt.icon || ctx.icon || 'terminal';
    const kicker = prompt.isError ? 'Error detectado' : (prompt.isWarning ? 'Advertencia' : (prompt.kicker || ctx.name || 'airgeddon'));

    const handle = modal({
      size,
      title: prompt.title || ctx.name,
      // El subtítulo solo se muestra cuando aporta algo que el cuerpo no
      // muestra: el cuerpo ya pinta `question` y `desc` cuando difieren.
      // Así el texto nunca aparece duplicado en el modal.
      subtitle: (prompt.isDefaultDesc || prompt.desc === prompt.question) ? '' : (prompt.desc || ''),
      icon: iconName,
      color,
      kicker,
      dismissible: true,
      footer: '',
      onClose: () => {
        // Solo se llega aquí con `current` activo cuando el cierre lo inicia
        // el usuario (X, Esc o clic fuera). Los cierres internos ponen
        // `current = null` antes de llamar a handle.close().
        if (current && current.signature === prompt.signature) {
          rememberDismissed(prompt.signature);
          current = null;
          if (AG.app && typeof AG.app.onInteractionClosed === 'function') AG.app.onInteractionClosed();
        }
      },
      onMount: (h) => mount(h, prompt),
    });

    current = { signature: prompt.signature, prompt, handle };
    AG.ui.icons(handle.el);
  }

  function mount(handle, prompt) {
    const { body, foot } = handle;
    switch (prompt.type) {
      case 'menu': mountMenu(handle, prompt); break;
      case 'network': mountNetwork(handle, prompt); break;
      case 'confirm': mountConfirm(handle, prompt); break;
      case 'text': mountText(handle, prompt); break;
      case 'password': mountPassword(handle, prompt); break;
      case 'enter': mountEnter(handle, prompt); break;
      default: mountUnknown(handle, prompt); break;
    }
    if (body) AG.ui.icons(body);
    if (foot) AG.ui.icons(foot);
  }

  // ── Helpers de cierre + envío ─────────────────────────────────────────────

  function commit(prompt, data, closeAfter = true) {
    if (prompt && (prompt.isStartup || prompt.context?.id === 'startup')) {
      lastStartupCommitTime = Date.now();
    } else if (prompt && prompt.type === 'menu') {
      lastStartupCommitTime = 0;
    }
    if (prompt && prompt.signature) {
      answered.add(prompt.signature);
      if (answered.size > 50) {
        const first = answered.values().next().value;
        answered.delete(first);
      }
    }
    suppress = { signature: prompt.signature, until: Date.now() + 2500 };
    if (closeAfter) close();
    sendLine(data);
    // Solo reanalizar pronto con temporizador si es un menú donde el script regresa
    // rápidamente al mismo menú con nuevas opciones tras una acción.
    if (prompt && prompt.type === 'menu') {
      if (AG.app && typeof AG.app.reanalyzeSoon === 'function') AG.app.reanalyzeSoon(2200);
    }
  }

  function consoleButton() {
    return `<button class="btn btn-ghost btn-sm" data-use-console>${icon('terminal')} Ver en consola</button>`;
  }

  function bindConsoleButton(handle) {
    const btn = handle.el.querySelector('[data-use-console]');
    if (btn) {
      btn.addEventListener('click', () => {
        dismiss();
        if (AG.terminal && AG.terminal.open) AG.terminal.open({ focus: true });
        if (window.AG && window.AG.ui && window.AG.ui.toast) {
          window.AG.ui.toast('Consola visible. El Asistente continuará guiándote en el siguiente paso.', 'info');
        }
      });
    }
  }

  // ── Menú en Cards Grid ────────────────────────────────────────────────────

  function mountMenu(handle, prompt) {
    const items = Array.isArray(prompt.items) ? prompt.items : [];
    const colorFor = (it) => AG.ui.tone(it.color || 'slate');
    const isFew = items.length <= 3;
    const isInterface = (prompt.context && prompt.context.id === 'select_interface') || items.some((it) => /chipset/i.test(it.text || it.desc));

    handle.body.innerHTML = `<div class="choice-list${isFew ? ' few-items' : ''}${isInterface ? ' interface-list' : ''}">${items.map((it) => `
      <button class="choice-card${it.destructive ? ' danger' : ''}" type="button" data-key="${esc(it.key)}">
        <div class="choice-card-top">
          <span class="choice-icon tone-${colorFor(it)}">${icon(it.icon || 'chevron-right')}</span>
          <span class="choice-key">${esc(it.key)}</span>
        </div>
        <div class="choice-card-main">
          <span class="choice-title">${esc(it.title || it.text)}</span>
          ${it.desc ? `<span class="choice-desc">${esc(it.desc)}</span>` : ''}
        </div>
        <div class="choice-card-foot">
          <span>Seleccionar</span>
          ${icon('chevron-right')}
        </div>
      </button>`).join('')}</div>`;

    handle.foot.innerHTML = `
      <div class="modal-actions" style="margin-left:auto">${consoleButton()}</div>`;

    handle.body.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const item = items.find((it) => it.key === key);
        if (item && item.destructive && AG.app && AG.app.confirmDestructive) {
          AG.app.confirmDestructive(item).then((ok) => { if (ok) commit(prompt, key); });
          return;
        }
        commit(prompt, key);
      });
    });

    bindConsoleButton(handle);
    bindKeyBuffer(handle, prompt, items.map((it) => it.key));
  }

  // ── Redes en Modal (Tabla interactiva / Cards) ───────────────────────────

  function mountNetwork(handle, prompt) {
    const nets = Array.isArray(prompt.nets) ? prompt.nets : [];
    let viewMode = 'table';
    try { viewMode = localStorage.getItem('ag-modal-net-view') || 'table'; } catch {}
    let filterQuery = '';
    let filterClientsOnly = false;
    let filterBand = 'all';
    let sortOption = 'signal-desc';
    try { sortOption = localStorage.getItem('ag-modal-net-sort') || 'signal-desc'; } catch {}

    handle.body.innerHTML = `
      <div class="toolbar" style="margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="search-wrap" style="flex:1;min-width:200px">
          ${icon('search')}
          <input class="input" type="search" id="netSearch" placeholder="Buscar por ESSID, BSSID o canal…" autocomplete="off">
        </div>
        <div class="toolbar-group">
          <label for="netBandFilter">Banda</label>
          <select class="select" id="netBandFilter">
            <option value="all">Todas</option>
            <option value="2.4">2.4 GHz</option>
            <option value="5">5 GHz</option>
          </select>
        </div>
        <div class="toolbar-group">
          <label for="netSortSelect">Ordenar</label>
          <select class="select" id="netSortSelect" style="max-width:185px">
            <option value="signal-desc">Mayor señal (más fuerte)</option>
            <option value="clients-first">Con clientes primero</option>
            <option value="signal-asc">Menor señal (más débil)</option>
            <option value="n-asc">Nº airgeddon (original)</option>
            <option value="essid-asc">Nombre (ESSID A-Z)</option>
          </select>
        </div>
        <button class="btn btn-ghost btn-sm" id="btnOnlyClients" type="button" title="Mostrar solo redes con clientes detectados">
          ${icon('users')} <span>Solo clientes</span>
        </button>
        <div class="toolbar-sep"></div>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm ${viewMode === 'table' ? 'active' : ''}" id="btnViewTable" type="button" title="Vista tabla">${icon('list')} Tabla</button>
          <button class="btn btn-ghost btn-sm ${viewMode === 'cards' ? 'active' : ''}" id="btnViewCards" type="button" title="Vista tarjetas">${icon('layout-grid')} Cards</button>
        </div>
        <span class="badge teal" id="netCount" style="margin-left:auto;font-weight:700">${nets.length} redes</span>
      </div>
      <div id="netContainer" style="max-height:58vh;overflow-y:auto;padding-right:4px"></div>`;

    const container = handle.body.querySelector('#netContainer');
    const search = handle.body.querySelector('#netSearch');
    const count = handle.body.querySelector('#netCount');
    const bandSelect = handle.body.querySelector('#netBandFilter');
    const sortSelect = handle.body.querySelector('#netSortSelect');
    const clientsBtn = handle.body.querySelector('#btnOnlyClients');
    const btnTable = handle.body.querySelector('#btnViewTable');
    const btnCards = handle.body.querySelector('#btnViewCards');

    if (sortSelect) sortSelect.value = sortOption;

    function render() {
      const q = filterQuery.trim().toLowerCase();
      let visible = nets.slice();
      if (q) {
        visible = visible.filter((n) => `${n.essid} ${n.bssid} ${n.channel}`.toLowerCase().includes(q));
      }
      if (filterBand !== 'all') {
        visible = visible.filter((n) => (n.band || '').includes(filterBand));
      }
      if (filterClientsOnly) {
        visible = visible.filter((n) => Boolean(n.hasClients));
      }

      // Ordenación según la opción activa (Mayor señal, con clientes primero, etc.)
      const knownAps = (window.AG && window.AG.state && window.AG.state.scan && window.AG.state.scan.aps) || [];
      const getClientScore = (n) => {
        const ap = knownAps.find((a) => (a.bssid || '').toUpperCase() === (n.bssid || '').toUpperCase());
        if (ap && Array.isArray(ap.stations) && ap.stations.length > 0) return ap.stations.length;
        if (n.hasClients) return 1;
        return 0;
      };

      visible.sort((a, b) => {
        switch (sortOption) {
          case 'signal-desc': {
            const diff = (Number(b.signal) || 0) - (Number(a.signal) || 0);
            if (diff !== 0) return diff;
            return (Number(a.n) || 0) - (Number(b.n) || 0);
          }
          case 'signal-asc': {
            const diff = (Number(a.signal) || 0) - (Number(b.signal) || 0);
            if (diff !== 0) return diff;
            return (Number(a.n) || 0) - (Number(b.n) || 0);
          }
          case 'clients-first': {
            const cA = getClientScore(a);
            const cB = getClientScore(b);
            if (cB !== cA) return cB - cA; // Más clientes primero
            // Si empatan en clientes, la de mayor señal primero
            const diffSig = (Number(b.signal) || 0) - (Number(a.signal) || 0);
            if (diffSig !== 0) return diffSig;
            return (Number(a.n) || 0) - (Number(b.n) || 0);
          }
          case 'essid-asc': {
            const nameA = (a.essid || '').toLowerCase();
            const nameB = (b.essid || '').toLowerCase();
            const cmp = nameA.localeCompare(nameB);
            if (cmp !== 0) return cmp;
            return (Number(a.n) || 0) - (Number(b.n) || 0);
          }
          case 'n-asc':
          default:
            return (Number(a.n) || 0) - (Number(b.n) || 0);
        }
      });

      count.textContent = `${visible.length} ${visible.length === 1 ? 'red' : 'redes'}`;

      if (!visible.length) {
        container.innerHTML = `<div class="empty-state" style="padding:36px 10px">
          <div class="empty-ico" style="width:48px;height:48px;border-radius:12px">${icon('radar')}</div>
          <h3 style="font-size:13.5px;font-weight:750">Sin coincidencias</h3>
          <p style="font-size:11.5px;color:var(--tx-3)">Prueba a desactivar filtros o cambiar la búsqueda.</p>
        </div>`;
        AG.ui.icons(container);
        return;
      }

      if (viewMode === 'table') {
        const sortIco = (col) => {
          if (col === 'signal') {
            if (sortOption === 'signal-desc') return ' ▼';
            if (sortOption === 'signal-asc') return ' ▲';
            return '';
          }
          if (col === 'clients') {
            if (sortOption === 'clients-first') return ' ▼';
            return '';
          }
          if (col === 'n') {
            if (sortOption === 'n-asc') return ' ▲';
            return '';
          }
          if (col === 'essid') {
            if (sortOption === 'essid-asc') return ' ▲';
            return '';
          }
          return '';
        };

        container.innerHTML = `
          <div class="table-wrap">
            <table class="net-table">
              <thead>
                <tr>
                  <th class="sortable ${sortOption === 'n-asc' ? 'active' : ''}" data-col="n" style="width:52px;text-align:center" title="Ordenar por número original">Nº${sortIco('n')}</th>
                  <th class="sortable ${sortOption === 'essid-asc' ? 'active' : ''}" data-col="essid" style="min-width:180px" title="Ordenar por ESSID (A-Z)">ESSID${sortIco('essid')}</th>
                  <th style="width:145px">BSSID</th>
                  <th style="width:85px;text-align:center">Canal</th>
                  <th style="width:85px">Banda</th>
                  <th class="sortable ${sortOption.startsWith('signal') ? 'active' : ''}" data-col="signal" style="width:105px" title="Ordenar por potencia de señal">Señal${sortIco('signal')}</th>
                  <th style="width:95px">Seguridad</th>
                  <th class="sortable ${sortOption === 'clients-first' ? 'active' : ''}" data-col="clients" style="width:95px;text-align:center" title="Ordenar por clientes conectados">Clientes${sortIco('clients')}</th>
                  <th class="td-action" style="width:135px;text-align:right">Objetivo</th>
                </tr>
              </thead>
              <tbody>
                ${visible.map((n) => {
                  const apMatch = knownAps.find((a) => (a.bssid || '').toUpperCase() === (n.bssid || '').toUpperCase());
                  const hasStationList = apMatch && Array.isArray(apMatch.stations) && apMatch.stations.length > 0;
                  return `
                  <tr data-key="${esc(n.n)}" style="cursor:pointer">
                    <td style="text-align:center"><span class="net-card-n">${esc(n.n)}</span></td>
                    <td class="td-ssid"><strong>${esc(n.essid || '(oculta)')}</strong></td>
                    <td class="td-mono">${esc(n.bssid)}</td>
                    <td class="td-center" style="white-space:nowrap"><span class="ch-badge">CH ${esc(n.channel)}</span></td>
                    <td class="td-mono" style="white-space:nowrap">${esc(n.band || '—')}</td>
                    <td style="white-space:nowrap">${signalBars(n.signal)}</td>
                    <td style="white-space:nowrap"><span class="enc ${encClass(n.securityKind)}">${esc(n.enc)}</span></td>
                    <td style="text-align:center;white-space:nowrap">
                      ${hasStationList ? `
                        <button class="btn-stations" type="button" data-action="modal-toggle-st" data-key="${esc(n.n)}" title="Ver clientes detectados">
                          ${icon('users')} <span>${apMatch.stations.length}</span> ${icon('chevron-down')}
                        </button>
                      ` : n.hasClients ? `
                        <span class="badge blue" style="font-weight:700">${icon('users')} ${esc(n.clients || '1+')}</span>
                      ` : `<span class="badge slate">0</span>`}
                    </td>
                    <td class="td-action" style="text-align:right;white-space:nowrap">
                      <button class="btn btn-green btn-audit-action" data-key="${esc(n.n)}" type="button">
                        ${icon('crosshair')} <span>Auditar</span>
                      </button>
                    </td>
                  </tr>
                  ${hasStationList ? `
                  <tr class="stations-row hidden" id="stModalRow-${esc(n.n)}">
                    <td colspan="9">
                      <div class="stations-box">
                        <div class="stations-title">
                          ${icon('users')} Estaciones detectadas en ${esc(n.essid)} (${esc(n.bssid)})
                        </div>
                        <table class="stations-table">
                          <thead>
                            <tr>
                              <th>STATION MAC</th>
                              <th>BSSID ASOCIADO</th>
                              <th>POTENCIA (PWR)</th>
                              <th>PAQUETES</th>
                              <th>PROBES</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${apMatch.stations.map((st) => `
                              <tr>
                                <td class="station-mac">${esc(st.mac)}</td>
                                <td>${esc(st.bssid || n.bssid)}</td>
                                <td>${st.power ? `${st.power} dBm` : '—'}</td>
                                <td>${esc(st.packets || 0)}</td>
                                <td class="station-probes">${esc(st.probed || '(asociado)')}</td>
                              </tr>
                            `).join('')}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>` : ''}`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="net-choice-list">
            ${visible.map((n) => `
              <button class="net-card-item" type="button" data-key="${esc(n.n)}">
                <div class="net-card-head">
                  <span class="net-card-n">${esc(n.n)}</span>
                  <div class="net-card-badges">
                    ${n.hasClients ? `<span class="badge blue" title="Clientes asociados detectados">${icon('users')} Clientes</span>` : ''}
                    <span class="enc ${encClass(n.securityKind)}">${esc(n.enc)}</span>
                  </div>
                </div>
                <div class="net-card-body">
                  <div class="net-card-ssid" title="${esc(n.essid)}">${esc(n.essid || '(Red Oculta)')}</div>
                  <div class="net-card-bssid">${esc(n.bssid)}</div>
                </div>
                <div class="net-card-foot">
                  <div class="net-card-ch">
                    <span class="ch-badge">CH ${esc(n.channel)}</span>
                    ${n.band && n.band !== '—' ? `<span class="band-badge">${esc(n.band)}</span>` : ''}
                  </div>
                  <div class="net-card-pwr">
                    ${signalBars(n.signal)}
                  </div>
                </div>
              </button>`).join('')}
          </div>`;
      }
      AG.ui.icons(container);
    }

    render();

    search?.addEventListener('input', () => { filterQuery = search.value; render(); });
    search?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = container.querySelector('[data-key]');
        if (first) first.click();
      }
    });

    bandSelect?.addEventListener('change', () => { filterBand = bandSelect.value; render(); });

    clientsBtn?.addEventListener('click', () => {
      filterClientsOnly = !filterClientsOnly;
      clientsBtn.classList.toggle('active', filterClientsOnly);
      clientsBtn.classList.toggle('btn-accent', filterClientsOnly);
      render();
    });

    btnTable?.addEventListener('click', () => {
      viewMode = 'table';
      try { localStorage.setItem('ag-modal-net-view', 'table'); } catch {}
      btnTable.classList.add('active');
      btnCards?.classList.remove('active');
      render();
    });

    btnCards?.addEventListener('click', () => {
      viewMode = 'cards';
      try { localStorage.setItem('ag-modal-net-view', 'cards'); } catch {}
      btnCards.classList.add('active');
      btnTable?.classList.remove('active');
      render();
    });

    sortSelect?.addEventListener('change', () => {
      sortOption = sortSelect.value;
      try { localStorage.setItem('ag-modal-net-sort', sortOption); } catch {}
      render();
    });

    container.addEventListener('click', (e) => {
      const thSort = e.target.closest('th.sortable');
      if (thSort) {
        const col = thSort.dataset.col;
        if (col === 'signal') {
          sortOption = sortOption === 'signal-desc' ? 'signal-asc' : 'signal-desc';
        } else if (col === 'clients') {
          sortOption = sortOption === 'clients-first' ? 'signal-desc' : 'clients-first';
        } else if (col === 'n') {
          sortOption = sortOption === 'n-asc' ? 'signal-desc' : 'n-asc';
        } else if (col === 'essid') {
          sortOption = sortOption === 'essid-asc' ? 'signal-desc' : 'essid-asc';
        }
        if (sortSelect) sortSelect.value = sortOption;
        try { localStorage.setItem('ag-modal-net-sort', sortOption); } catch {}
        render();
        return;
      }

      const toggleSt = e.target.closest('[data-action="modal-toggle-st"]');
      if (toggleSt) {
        e.stopPropagation();
        const key = toggleSt.dataset.key;
        if (key) {
          const row = container.querySelector('#stModalRow-' + key);
          if (row) {
            row.classList.toggle('hidden');
            toggleSt.classList.toggle('active');
          }
        }
        return;
      }

      const el = e.target.closest('[data-key]');
      if (!el) return;
      const key = el.dataset.key;
      const net = nets.find((x) => x.n === key);
      if (AG.app && typeof AG.app.setInteractionMode === 'function') {
        AG.app.setInteractionMode('assistant', { focus: false });
      }
      commit(prompt, key);
      if (net && window.AG && window.AG.ui && window.AG.ui.toast) {
        window.AG.ui.toast(`Red ${net.essid || net.bssid} seleccionada (#${key})`, 'success');
      }
    });

    handle.foot.innerHTML = `<div class="modal-hint">${icon('mouse-pointer-click')} Haz clic en cualquier red para auditarla</div>
      <div class="modal-actions">${consoleButton()}</div>`;

    bindConsoleButton(handle);
    bindKeyBuffer(handle, prompt, nets.map((n) => n.n));
  }

  // ── Confirmación ──────────────────────────────────────────────────────────

  function mountConfirm(handle, prompt) {
    handle.body.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-ico">${icon('help-circle')}</div>
        <div class="confirm-content">
          <p class="confirm-question">${esc(prompt.question || '¿Deseas continuar?')}</p>
          <div class="confirm-badge-row">
            <span class="badge ${prompt.defaultYes ? 'teal' : 'slate'}">Opción predeterminada: ${prompt.defaultYes ? 'Sí' : 'No'}</span>
          </div>
        </div>
      </div>`;

    handle.foot.innerHTML = `
      <div class="modal-actions" style="margin-left:auto">
        ${consoleButton()}
        <button class="btn btn-ghost" data-answer="n">No</button>
        <button class="btn btn-accent" data-answer="y">Sí</button>
      </div>`;

    handle.foot.querySelectorAll('[data-answer]').forEach((btn) => {
      btn.addEventListener('click', () => commit(prompt, btn.dataset.answer));
    });
    bindConsoleButton(handle);

    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'y' || k === 's') { e.preventDefault(); commit(prompt, 'y'); }
      else if (k === 'n') { e.preventDefault(); commit(prompt, 'n'); }
      else if (k === 'enter') { e.preventDefault(); commit(prompt, prompt.defaultYes ? 'y' : 'n'); }
    };
    handle.el.addEventListener('keydown', onKey);
  }

  // ── Texto libre ───────────────────────────────────────────────────────────

  function mountText(handle, prompt) {
    const q = prompt.question || 'Introduce un valor';
    const defMatch = q.match(/\[([0-9a-zA-Z._\-/]+)\]:?\s*$/);
    const defVal = defMatch ? defMatch[1] : '';
    handle.body.innerHTML = `
      <div class="form-block">
        <label class="form-label" for="agText">${esc(q)}</label>
        <input class="form-input mono" id="agText" type="text" autocomplete="off" spellcheck="false" placeholder="${defVal ? `Predeterminado: ${esc(defVal)} (pulsa Enter)` : 'Escribe aquí…'}" autofocus>
        <p class="form-help">${defVal ? `Pulsa Enter directamente para aceptar el valor propuesto (${esc(defVal)}) o escribe uno diferente.` : 'Se enviará a airgeddon exactamente como lo escribas, seguido de Enter.'}</p>
      </div>`;

    const input = handle.body.querySelector('#agText');
    const submit = () => {
      const value = input.value;
      commit(prompt, value);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    handle.foot.innerHTML = `
      <div class="modal-actions" style="margin-left:auto">
        ${consoleButton()}
        <button class="btn btn-accent" data-submit>Enviar</button>
      </div>`;

    handle.foot.querySelector('[data-submit]').addEventListener('click', submit);
    bindConsoleButton(handle);
    setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 60);
  }

  // ── Contraseña ────────────────────────────────────────────────────────────

  function mountPassword(handle, prompt) {
    handle.body.innerHTML = `
      <div class="form-block">
        <label class="form-label" for="agPass">${esc(prompt.question || 'Contraseña')}</label>
        <div class="pw-wrap">
          <input class="form-input mono" id="agPass" type="password" autocomplete="current-password" spellcheck="false" placeholder="Contraseña de sudo" autofocus>
          <button class="pw-toggle" type="button" data-toggle-pw aria-label="Mostrar u ocultar">${icon('eye')}</button>
        </div>
        <p class="form-help">La contraseña se envía al servidor local y solo se mantiene en memoria. Nunca se escribe en disco.</p>
      </div>`;

    const input = handle.body.querySelector('#agPass');
    const toggle = handle.body.querySelector('[data-toggle-pw]');
    toggle.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      const name = input.type === 'password' ? 'eye' : 'eye-off';
      toggle.innerHTML = icon(name);
      AG.ui.icons(toggle);
      input.focus();
    });

    const submit = () => {
      if (!input.value) { input.focus(); return; }
      commit(prompt, input.value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    handle.foot.innerHTML = `
      <div class="modal-actions" style="margin-left:auto">
        ${consoleButton()}
        <button class="btn btn-accent" data-submit>Desbloquear</button>
      </div>`;

    handle.foot.querySelector('[data-submit]').addEventListener('click', submit);
    bindConsoleButton(handle);
    setTimeout(() => { try { input.focus(); } catch {} }, 60);
  }

  // ── Continuar (Enter) ─────────────────────────────────────────────────────

  function mountEnter(handle, prompt) {
    const color = prompt.color || (prompt.isError ? 'red' : (prompt.isWarning ? 'amber' : 'teal'));
    const btnClass = prompt.isError ? 'btn-danger' : (prompt.isWarning ? 'btn-warning' : 'btn-accent');
    // El `desc` ya se muestra como subtítulo en la cabecera del modal
    // (ver open()). Aquí solo se pinta si aporta información adicional.
    const extraDesc = prompt.desc && prompt.desc !== prompt.question && !prompt.isDefaultDesc
      ? `<p style="margin-top:6px;font-size:12.5px;color:var(--tx-2);line-height:1.5">${esc(prompt.desc)}</p>`
      : '';

    handle.body.innerHTML = `
      <div class="confirm-box" style="border-color:var(--${color}-soft);background:var(--${color}-soft)">
        <div class="confirm-ico" style="background:var(--${color}-soft);color:var(--${color})">
          ${icon(prompt.icon || (prompt.isError ? 'shield-alert' : (prompt.isWarning ? 'alert-triangle' : 'corner-down-left')))}
        </div>
        <div class="confirm-content" style="flex:1">
          <p class="confirm-question" style="color:var(--tx-1);font-weight:700;font-size:14px;line-height:1.4">
            ${esc(prompt.question || 'Pulsa Enter para continuar.')}
          </p>
          ${extraDesc}
          ${prompt.suggestion ? `
            <div style="margin-top:10px;padding:8px 12px;background:var(--bg-1);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--tx-2);display:flex;align-items:center;gap:8px">
              ${icon('info')} <span>${esc(prompt.suggestion)}</span>
            </div>` : ''}
        </div>
      </div>`;

    handle.foot.innerHTML = `
      <div class="modal-actions" style="margin-left:auto">
        ${consoleButton()}
        <button class="btn ${btnClass}" data-continue>
          ${icon(prompt.isError ? 'check' : 'corner-down-left')} ${esc(prompt.buttonText || 'Continuar')}
        </button>
      </div>`;

    const submit = () => commit(prompt, '');
    handle.foot.querySelector('[data-continue]').addEventListener('click', submit);
    bindConsoleButton(handle);

    handle.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) {
        e.preventDefault();
        submit();
      }
    });
  }

  function mountUnknown(handle, prompt) {
    handle.body.innerHTML = `
      <div class="detail-note">${icon('terminal')}
        <div>airgeddon está esperando una respuesta. Puedes escribir directamente en la consola inferior.</div>
      </div>`;
    handle.foot.innerHTML = `<div class="modal-hint">La consola está disponible abajo</div>
      <div class="modal-actions">${consoleButton()}</div>`;
    bindConsoleButton(handle);
  }

  // ── Buffer de teclado numérico ────────────────────────────────────────────

  function bindKeyBuffer(handle, prompt, keys) {
    let buffer = '';
    let timer = null;
    const valid = keys.map(String);

    const matchesExact = (b) => valid.filter((k) => k === b);
    const matchesPrefix = (b) => valid.filter((k) => k.startsWith(b) && k !== b);

    function reset() {
      buffer = '';
      if (timer) { clearTimeout(timer); timer = null; }
      const active = handle.el.querySelector('.choice.is-typed, .net-choice.is-typed');
      if (active) active.classList.remove('is-typed');
    }

    function select(key) {
      reset();
      commit(prompt, key);
    }

    function press(digit) {
      buffer += digit;
      if (!valid.some((k) => k.startsWith(buffer))) {
        buffer = digit;
        if (!valid.some((k) => k.startsWith(buffer))) { reset(); return; }
      }

      const exact = matchesExact(buffer);
      const prefix = matchesPrefix(buffer);

      handle.el.querySelectorAll('[data-key]').forEach((el) => {
        el.classList.toggle('is-typed', el.dataset.key === buffer);
      });

      if (timer) { clearTimeout(timer); timer = null; }
      if (exact.length === 1 && prefix.length === 0) {
        timer = setTimeout(() => select(buffer), 260);
      }
    }

    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
        return;
      }
      if (e.key === 'Backspace') {
        if (buffer) { e.preventDefault(); buffer = buffer.slice(0, -1); }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (buffer && matchesExact(buffer).length === 1) select(buffer);
        else reset();
      }
    };

    handle.el.addEventListener('keydown', onKey);
  }

  return {
    setSender, update, open, close, dismiss, forceOpen, respond,
    isOpen, currentPrompt, setMode, getMode,
  };
})();
