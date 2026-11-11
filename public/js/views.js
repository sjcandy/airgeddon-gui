'use strict';

window.AG = window.AG || {};

/**
 * Render de las vistas. Cada función devuelve HTML; app.js lo inserta y
 * vuelve a crear los iconos de Lucide.
 */
AG.views = (() => {
  const { esc, icon, signalBars, encClass, formatBytes, timeAgo, clockTime, shortDate, formatDuration } = AG.ui;

  function tone(color) { return AG.ui.tone(color); }

  function pageIntro(title, desc, actions = '') {
    return `<div class="page-intro">
      <div><h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </div>`;
  }

  function sectionTitle(iconName, label, actions = '') {
    return `<div class="section-title">${icon(iconName)}<span>${esc(label)}</span>${actions ? `<div class="section-actions">${actions}</div>` : ''}</div>`;
  }

  function emptyState(iconName, title, desc, action = '') {
    return `<div class="empty-state">
      <div class="empty-ico">${icon(iconName)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      ${action}
    </div>`;
  }

  function eventIcon(type) {
    return ({
      success: 'check-circle-2', error: 'alert-circle', warn: 'alert-triangle',
      info: 'info', session: 'terminal', action: 'mouse-pointer-click',
      scan: 'radar', auth: 'key-round',
    })[type] || 'circle';
  }

  function activityList(events, limit = 7) {
    const list = (events || []).slice(0, limit);
    if (!list.length) {
      return `<div class="empty-state" style="padding:22px 10px">
        <div class="empty-ico" style="width:40px;height:40px;border-radius:11px">${icon('activity')}</div>
        <h3 style="font-size:12px">Sin actividad</h3>
        <p style="font-size:10.5px">Las acciones aparecerán aquí.</p>
      </div>`;
    }
    return `<div class="activity">${list.map((ev) => `
      <div class="activity-item">
        <span class="activity-ico tone-${tone(ev.type === 'warn' ? 'amber' : ev.type === 'error' ? 'red' : ev.type === 'success' ? 'green' : 'blue')}">${icon(eventIcon(ev.type))}</span>
        <div class="activity-copy">
          <strong>${esc(ev.message)}</strong>
          ${ev.detail ? `<span>${esc(ev.detail)}</span>` : ''}
        </div>
        <span class="activity-time">${esc(clockTime(ev.ts))}</span>
      </div>`).join('')}</div>`;
  }

  function sessionLabel(state) {
    if (state.session && state.session.running) return 'Sesión activa';
    if (state.prompt) return 'Esperando respuesta';
    return 'Sin sesión';
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  function dashboard(state) {
    const session = state.session || {};
    const sudo = state.sudo || {};
    const scan = state.scan || {};
    const interfaces = state.interfaces || [];
    const aps = scan.aps || [];
    const stations = scan.stations || [];
    const captures = state.captures || [];
    const monitor = interfaces.find((i) => i.monitor);
    const wifi = interfaces.filter((i) => i.wireless);
    const running = Boolean(session.running);

    const sudoText = sudo.passwordless ? 'sin contraseña' : sudo.authenticated ? 'autenticado' : 'bloqueado';
    const scanText = scan.running ? `activo · ${scan.iface || ''}` : 'detenido';

    return `
      <div class="dash-hero">
        <div class="hero-copy">
          <div class="hero-kicker"><span class="dot ${running ? 'on' : ''}"></span>${esc(sessionLabel(state))}</div>
          <h2>Auditoría inalámbrica</h2>
          <p>Controla airgeddon mediante botones y ventanas. La consola sigue disponible abajo para ver cada proceso en vivo, pero ya no es el centro de la operación.</p>
          <div class="hero-actions">
            ${running
              ? `<button class="btn btn-danger" data-action="session-stop">${icon('square')} Detener sesión</button>
                 <button class="btn btn-accent" data-action="return-assistant">${icon('sparkles')} Asistente visual</button>`
              : `<button class="btn btn-accent" data-action="session-start">${icon('play')} Iniciar airgeddon</button>`}
            <button class="btn btn-ghost" data-action="goto-networks">${icon('radar')} Escanear redes</button>
            <button class="btn btn-ghost" data-action="toggle-console">${icon('terminal')} Ver consola</button>
            <button class="btn btn-danger btn-sm" data-action="kill-hung" title="Matar procesos colgados de sesiones anteriores">${icon('shield-alert')} Matar procesos</button>
          </div>
        </div>
        <div class="hero-side">
          <div class="hero-metric"><span>airgeddon</span><strong>v${esc(state.airgeddonVersion || '—')}</strong></div>
          <div class="hero-metric"><span>sudo</span><strong style="color:var(--${sudo.authenticated ? 'green' : 'amber'})">${esc(sudoText)}</strong></div>
          <div class="hero-metric"><span>Interfaz</span><strong>${esc(monitor ? monitor.name : 'ninguna en monitor')}</strong></div>
          <div class="hero-metric"><span>Escaneo</span><strong style="color:var(--${scan.running ? 'green' : 'tx-3'})">${esc(scanText)}</strong></div>
        </div>
      </div>

      <div class="stat-grid">
        ${statCard('radar', 'teal', aps.length, 'Redes detectadas')}
        ${statCard('users', 'blue', stations.length, 'Clientes vistos')}
        ${statCard('file-key', 'amber', captures.length, 'Capturas guardadas')}
        ${statCard('network', 'purple', wifi.length, 'Interfaces wifi')}
      </div>

      <div class="dash-grid">
        <div>
          ${sectionTitle('mouse-pointer-click', 'Acciones principales')}
          <div class="action-grid">
            ${(AG.data.mainActions || []).map((a) => `
              <button class="action-card" type="button" data-action="main-action" data-key="${esc(a.key)}" data-title="${esc(a.title)}">
                <span class="action-ico tone-${tone(a.color)}">${icon(a.icon)}</span>
                <span class="action-copy">
                  <span class="action-title">${esc(a.title)}</span>
                  <span class="action-desc">${esc(a.desc)}</span>
                </span>
                <span class="action-key">${esc(a.key)}</span>
              </button>`).join('')}
          </div>
        </div>
        <div>
          ${sectionTitle('activity', 'Sesión actual')}
          ${currentCard(state)}
          ${sectionTitle('history', 'Actividad reciente', `<button class="btn btn-ghost btn-sm" data-action="switch-view" data-view="history">Ver todo</button>`)}
          <div class="card card-pad">${activityList(state.events)}</div>
        </div>
      </div>`;
  }

  function statCard(iconName, color, value, label) {
    return `<div class="stat-card">
      <span class="stat-ico tone-${tone(color)}">${icon(iconName)}</span>
      <span class="stat-copy"><strong>${esc(value)}</strong><span>${esc(label)}</span></span>
    </div>`;
  }

  function currentCard(state) {
    const prompt = state.prompt;
    const session = state.session || {};
    if (prompt) {
      const ctx = prompt.context || {};
      const color = ctx.color || 'teal';
      return `<div class="current-card active">
        <div class="current-head">
          <span class="current-ico tone-${tone(color)}">${icon(ctx.icon || 'terminal')}</span>
          <div class="current-copy">
            <strong>${esc(prompt.title || ctx.name || 'Acción pendiente')}</strong>
            <span>${esc(ctx.name || 'airgeddon')}</span>
          </div>
          <span class="badge amber" style="margin-left:auto">PENDIENTE</span>
        </div>
        <div class="current-question">${esc(prompt.question || prompt.desc || 'airgeddon espera tu respuesta.')}</div>
        <div class="current-actions">
          <button class="btn btn-accent btn-sm" data-action="open-prompt">${icon('mouse-pointer-click')} Responder</button>
          <button class="btn btn-ghost btn-sm" data-action="toggle-console">${icon('terminal')} Consola</button>
        </div>
      </div>`;
    }

    if (session.running) {
      return `<div class="current-card active">
        <div class="current-head">
          <span class="current-ico tone-green">${icon('activity')}</span>
          <div class="current-copy">
            <strong>airgeddon en ejecución</strong>
            <span>${session.startedAt ? `Iniciada ${esc(timeAgo(session.startedAt))}` : 'Sesión activa'}</span>
          </div>
        </div>
        <div class="current-question">La consola está mostrando la salida en tiempo real. Cuando airgeddon pida una respuesta, aparecerá aquí una ventana para continuar.</div>
        <div class="current-actions">
          <button class="btn btn-ghost btn-sm" data-action="toggle-console">${icon('terminal')} Abrir consola</button>
          <button class="btn btn-danger btn-sm" data-action="session-stop">${icon('square')} Detener</button>
        </div>
      </div>`;
    }

    return `<div class="current-card">
      <div class="current-head">
        <span class="current-ico tone-slate">${icon('power')}</span>
        <div class="current-copy">
          <strong>Sin sesión activa</strong>
          <span>Inicia airgeddon para comenzar</span>
        </div>
      </div>
      <div class="current-question">Al iniciar la sesión, airgeddon se ejecutará en la consola inferior. La GUI detectará los menús y abrirá ventanas para que solo tengas que elegir opciones.</div>
      <div class="current-actions">
        <button class="btn btn-accent btn-sm" data-action="session-start">${icon('play')} Iniciar sesión</button>
      </div>
    </div>`;
  }

  // ── Auditorías ───────────────────────────────────────────────────────────

  function audits(state) {
    return `
      ${pageIntro(
        'Auditorías guiadas',
        'Cada tarjeta abre el flujo correspondiente dentro de airgeddon y te acompaña con ventanas de selección. Elige una auditoría para empezar.',
        `<button class="btn btn-ghost" data-action="toggle-console">${icon('terminal')} Ver consola</button>
         <button class="btn btn-ghost" data-action="save-template">${icon('save')} Guardar plantilla</button>
         <button class="btn btn-ghost" data-action="load-template">${icon('folder-open')} Cargar plantilla</button>`
      )}
      <div class="audit-grid">
        ${(AG.data.audits || []).map((a) => `
          <article class="audit-card" style="--tone-bg:var(--${tone(a.color)}-soft)">
            <div class="audit-head">
              <span class="audit-ico tone-${tone(a.color)}">${icon(a.icon)}</span>
              <div class="audit-head-copy">
                <h3>${esc(a.title)}</h3>
                <p>${esc(a.subtitle)}</p>
              </div>
            </div>
            <div class="audit-tags">${(a.tags || []).map((t) => `<span class="badge slate">${esc(t)}</span>`).join('')}</div>
            <div class="audit-steps">
              ${(a.steps || []).slice(0, 3).map((s, i) => `<div class="audit-step"><span>${i + 1}</span>${esc(s)}</div>`).join('')}
            </div>
            <div class="audit-progress">
              <div class="audit-progress-bar"><div class="audit-progress-fill" style="width:${state.auditProgress && state.auditProgress[a.id] ? state.auditProgress[a.id] : 0}%"></div></div>
              <span class="audit-progress-label">${state.auditProgress && state.auditProgress[a.id] ? state.auditProgress[a.id] : 0}%</span>
            </div>
            <div class="audit-notes">
              <textarea class="audit-note-input" data-action="audit-note" data-audit="${esc(a.id)}" placeholder="Notas de la auditoría…">${esc((state.auditNotes || {})[a.id] || '')}</textarea>
            </div>
            <div class="audit-foot">
              <button class="btn btn-accent btn-sm" data-action="start-audit" data-audit="${esc(a.id)}" data-key="${esc(a.key)}">${icon('play')} Iniciar</button>
              <button class="btn btn-ghost btn-sm" data-action="audit-guide" data-audit="${esc(a.id)}">${icon('book-open')} Guía</button>
              <button class="btn btn-ghost btn-sm" data-action="audit-progress-inc" data-audit="${esc(a.id)}">${icon('plus')} Progreso</button>
            </div>
          </article>`).join('')}
      </div>`;
  }

  // ── Redes ────────────────────────────────────────────────────────────────

  function networks(state) {
    const scan = state.scan || {};
    const interfaces = state.interfaces || [];
    const wireless = interfaces.filter((i) => i.wireless);
    const monitor = interfaces.find((i) => i.monitor);
    const selected = state.scanIface || (monitor ? monitor.name : (wireless[0] && wireless[0].name) || '');
    const filter = state.netFilter || '';
    const sortKey = state.netSortKey || 'signal';
    const sortDir = state.netSortDir || 'desc';
    const minSignal = state.netMinSignal || 0;
    const bandFilter = state.netBandFilter || 'all';
    let aps = (scan.aps || []).slice();
    if (minSignal > 0) aps = aps.filter(function(a) { return (a.signal || 0) >= minSignal; });
    if (bandFilter !== 'all') aps = aps.filter(function(a) { return (a.band || '').includes(bandFilter); });
    aps = aps.sort((a, b) => {
      let va, vb;
      switch (sortKey) {
        case 'essid': va = (a.essid || '').toLowerCase(); vb = (b.essid || '').toLowerCase(); break;
        case 'bssid': va = a.bssid || ''; vb = b.bssid || ''; break;
        case 'channel': va = a.channel || 0; vb = b.channel || 0; break;
        case 'band': va = a.band || ''; vb = b.band || ''; break;
        case 'signal': va = a.signal || 0; vb = b.signal || 0; break;
        case 'security': va = a.security || ''; vb = b.security || ''; break;
        case 'clients': va = a.clients || 0; vb = b.clients || 0; break;
        default: va = a.signal || 0; vb = b.signal || 0;
      }
      if (typeof va === 'string') {
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    const visible = aps.filter((ap) => !filter || `${ap.essid} ${ap.bssid} ${ap.channel}`.toLowerCase().includes(filter.toLowerCase()));

    const ifaceOptions = wireless.length
      ? wireless.map((i) => `<option value="${esc(i.name)}"${i.name === selected ? ' selected' : ''}>${esc(i.name)} · ${esc(i.mode || 'wifi')}${i.monitor ? ' (monitor)' : ''}</option>`).join('')
      : '<option value="">Sin interfaces wifi</option>';

    return `
      ${pageIntro(
        'Redes cercanas',
        'Escanea el espectro con airodump-ng y elige un objetivo para auditarlo. La tabla se actualiza en vivo.',
        `<button class="btn btn-ghost" data-action="refresh-interfaces">${icon('refresh-cw')} Interfaces</button>
         <button class="btn btn-ghost" data-action="export-csv">${icon('download')} CSV</button>
         <div class="toolbar-sep"></div>
         <button class="btn btn-ghost btn-sm" data-action="net-view-table">Tabla</button>
         <button class="btn btn-ghost btn-sm" data-action="net-view-cards">Cards</button>`
      )}

      <div class="toolbar">
        <div class="toolbar-group">
          <label for="scanIface">Interfaz</label>
          <select class="select" id="scanIface" data-action="scan-iface">${ifaceOptions}</select>
        </div>
        <div class="toolbar-group">
          <label for="scanBand">Banda</label>
          <select class="select" id="scanBand" data-action="scan-band">
            <option value="abg"${(scan.band || 'abg') === 'abg' ? ' selected' : ''}>2.4 + 5 GHz</option>
            <option value="bg"${scan.band === 'bg' ? ' selected' : ''}>2.4 GHz</option>
            <option value="a"${scan.band === 'a' ? ' selected' : ''}>5 GHz</option>
          </select>
        </div>
        <div class="toolbar-sep"></div>
        ${scan.running
          ? `<button class="btn btn-danger btn-sm" data-action="scan-stop">${icon('square')} Detener escaneo</button>`
          : `<button class="btn btn-accent btn-sm" data-action="scan-start">${icon('radar')} Iniciar escaneo</button>`}
        <div class="toolbar-sep"></div>
        <div class="search-wrap">
          ${icon('search')}
          <input class="input" id="netFilter" type="search" placeholder="Filtrar redes…" value="${esc(filter)}" autocomplete="off">
        </div>
        <div class="toolbar-sep"></div>
        <div class="toolbar-group">
          <label>Señal mín.</label>
          <input type="range" min="0" max="100" value="${state.netMinSignal || 0}" class="range-input" data-action="net-min-signal">
          <span class="badge slate">${state.netMinSignal || 0}%</span>
        </div>
        <div class="toolbar-group">
          <label>Banda</label>
          <select class="select" data-action="net-band-filter">
            <option value="all"${(state.netBandFilter || 'all') === 'all' ? ' selected' : ''}>Todas</option>
            <option value="2.4"${state.netBandFilter === '2.4' ? ' selected' : ''}>2.4 GHz</option>
            <option value="5"${state.netBandFilter === '5' ? ' selected' : ''}>5 GHz</option>
          </select>
        </div>
        <span class="badge teal" style="margin-left:auto">${visible.length} redes</span>
      </div>

      ${aps.length && state.netViewMode === 'cards' ? `
        <div class="net-card-grid">
          ${visible.map((ap) => {
            const bssidKey = ap.bssid.replace(/[^a-zA-Z0-9]/g, '');
            const hasStations = Array.isArray(ap.stations) && ap.stations.length > 0;
            return `
            <div class="net-card" data-action="network-select" data-bssid="${esc(ap.bssid)}">
              <div class="net-card-head">
                <button class="fav-btn${(state.netFavorites || []).includes(ap.bssid) ? ' active' : ''}" data-action="net-fav" data-bssid="${esc(ap.bssid)}">${icon((state.netFavorites || []).includes(ap.bssid) ? 'star' : 'star-off')}</button>
                <span class="net-card-ssid">${esc(ap.essid)}</span>
                <span class="enc ${encClass(ap.securityKind)}">${esc(ap.security)}</span>
              </div>
              <div class="net-card-body">
                <div class="net-card-row"><span>BSSID</span><strong>${esc(ap.bssid)}</strong></div>
                <div class="net-card-row"><span>Canal</span><strong>${esc(ap.channel)} · ${esc(ap.band || '—')}</strong></div>
                <div class="net-card-row"><span>Señal</span><strong>${signalBars(ap.signal)}</strong></div>
                <div class="net-card-row">
                  <span>Clientes</span>
                  ${hasStations ? `
                    <button class="btn-stations" type="button" data-action="toggle-stations-card" data-bssid="${esc(ap.bssid)}" title="Ver clientes">
                      ${icon('users')} <span>${ap.stations.length}</span> ${icon('chevron-down')}
                    </button>
                  ` : `<strong>${esc(ap.clients || 0)}</strong>`}
                </div>
                ${hasStations ? `
                <div class="stations-box hidden" id="stCard-${bssidKey}" style="margin-top:8px">
                  <div class="stations-title">${icon('users')} Clientes asociados (${ap.stations.length})</div>
                  <table class="stations-table">
                    <thead>
                      <tr>
                        <th>STATION</th>
                        <th>PWR</th>
                        <th>PAQ</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${ap.stations.map((st) => `
                        <tr>
                          <td class="station-mac">${esc(st.mac)}</td>
                          <td>${st.power ? `${st.power} dBm` : '—'}</td>
                          <td>${esc(st.packets || 0)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>` : ''}
              </div>
              <div class="net-card-foot">
                <button class="btn btn-soft btn-sm" data-action="network-audit" data-bssid="${esc(ap.bssid)}">${icon('crosshair')} Auditar</button>
              </div>
            </div>`;
          }).join('')}
        </div>`
      : aps.length ? `
        <div class="table-wrap">
          <table class="net-table">
            <thead><tr>
              <th class="th-fav">Fav</th>
              <th data-sort="essid" class="sortable">ESSID ${state.netSortKey === 'essid' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="bssid" class="sortable">BSSID ${state.netSortKey === 'bssid' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="channel" class="sortable">CH ${state.netSortKey === 'channel' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="band" class="sortable">Banda ${state.netSortKey === 'band' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="signal" class="sortable">Señal ${state.netSortKey === 'signal' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="security" class="sortable">Seguridad ${state.netSortKey === 'security' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th data-sort="clients" class="sortable">Clientes ${state.netSortKey === 'clients' ? (state.netSortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${visible.map((ap) => {
                const bssidKey = ap.bssid.replace(/[^a-zA-Z0-9]/g, '');
                const hasStations = Array.isArray(ap.stations) && ap.stations.length > 0;
                return `
                <tr data-action="network-select" data-bssid="${esc(ap.bssid)}" title="Seleccionar ${esc(ap.essid)}">
                   <td class="td-fav"><button class="fav-btn" data-action="net-fav" data-bssid="${esc(ap.bssid)}">Fav</button></td>
                   <td class="td-ssid">${esc(ap.essid)}</td>
                  <td class="td-mono">${esc(ap.bssid)}</td>
                  <td class="td-num">${esc(ap.channel)}</td>
                  <td class="td-mono">${esc(ap.band || '—')}</td>
                  <td>${signalBars(ap.signal)}</td>
                  <td><span class="enc ${encClass(ap.securityKind)}">${esc(ap.security)}</span></td>
                  <td class="td-num">
                    ${hasStations ? `
                      <button class="btn-stations" type="button" data-action="toggle-stations" data-bssid="${esc(ap.bssid)}" title="Ver clientes conectados">
                        ${icon('users')} <span>${ap.stations.length}</span> ${icon('chevron-down')}
                      </button>
                    ` : (ap.clients || 0)}
                  </td>
                  <td class="td-center"><button class="btn btn-soft btn-sm" data-action="network-audit" data-bssid="${esc(ap.bssid)}">${icon('crosshair')} Auditar</button></td>
                </tr>
                ${hasStations ? `
                <tr class="stations-row hidden" id="stRow-${bssidKey}">
                  <td colspan="9">
                    <div class="stations-box">
                      <div class="stations-title">
                        ${icon('users')} Estaciones conectadas a ${esc(ap.essid)} (${esc(ap.bssid)})
                      </div>
                      <table class="stations-table">
                        <thead>
                          <tr>
                            <th>STATION MAC</th>
                            <th>BSSID ASOCIADO</th>
                            <th>POTENCIA (PWR)</th>
                            <th>PAQUETES (FRAMES)</th>
                            <th>PROBES (REDES SONDEADAS)</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${ap.stations.map((st) => `
                            <tr>
                              <td class="station-mac">${esc(st.mac)}</td>
                              <td>${esc(st.bssid || ap.bssid)}</td>
                              <td>${st.power ? `${st.power} dBm` : '—'}</td>
                              <td>${esc(st.packets || 0)}</td>
                              <td class="station-probes">${esc(st.probed || '(sin sondeos)')}</td>
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
          <div class="table-foot">
            <span class="scan-live">${scan.running ? '<span class="dot"></span> Escaneando en vivo' : 'Escaneo detenido'}</span>
            <span>${scan.updatedAt ? `Actualizado ${esc(timeAgo(scan.updatedAt))}` : 'Sin datos'} · ${aps.length} AP · ${(scan.stations || []).length} clientes</span>
          </div>
        </div>`
      : emptyState(
          'radar',
          scan.running ? 'Buscando redes…' : 'Todavía no hay redes',
          scan.running
            ? 'airodump-ng está escuchando. Las redes aparecerán aquí en cuanto se detecten.'
            : 'Pon una interfaz en modo monitor y lanza un escaneo para descubrir redes cercanas.',
          scan.running ? '' : `<button class="btn btn-accent" data-action="scan-start">${icon('radar')} Iniciar escaneo</button>`
        )}`;
  }

  // ── Interfaces ───────────────────────────────────────────────────────────

  function interfaces(state) {
    const list = state.interfaces || [];
    return `
      ${pageIntro(
        'Interfaces de red',
        'Activa el modo monitor, vuelve a managed o detén procesos que bloqueen la tarjeta. Los cambios requieren sudo.',
        `<button class="btn btn-ghost" data-action="refresh-interfaces">${icon('refresh-cw')} Actualizar</button>
         <button class="btn btn-danger" data-action="iface-kill">${icon('shield-alert')} Matar procesos colgados</button>`
      )}
      ${list.length ? `<div class="iface-grid">${list.map(ifaceCard).join('')}</div>`
        : emptyState('network', 'Sin interfaces', 'No se detectaron interfaces de red en el sistema.', `<button class="btn btn-accent" data-action="refresh-interfaces">${icon('refresh-cw')} Reintentar</button>`)}`;
  }

  function ifaceCard(i) {
    const isMonitor = i.monitor;
    const color = isMonitor ? 'green' : i.wireless ? 'teal' : 'slate';
    const modeBadge = isMonitor
      ? '<span class="badge green">MONITOR</span>'
      : i.wireless ? `<span class="badge blue">${esc((i.mode || 'wifi').toUpperCase())}</span>`
        : '<span class="badge slate">ETHERNET</span>';
    return `<div class="iface-card">
      <div class="iface-head">
        <span class="iface-ico tone-${color}">${icon(i.wireless ? (isMonitor ? 'radio' : 'wifi') : 'cable')}</span>
        <div class="iface-title">
          <strong>${esc(i.name)}</strong>
          <span>${esc(i.driver || 'sin driver')} · ${esc(i.state || '—')}</span>
        </div>
        ${modeBadge}
      </div>
      <div class="iface-rows">
        <div class="iface-row"><span>MAC</span><strong>${esc(i.mac || '—')}</strong></div>
        <div class="iface-row"><span>Canal / banda</span><strong>${esc(i.channel || '—')}${i.band ? ` · ${esc(i.band)}` : ''}</strong></div>
        <div class="iface-row"><span>Potencia TX</span><strong>${esc(i.txpower || '—')}</strong></div>
        <div class="iface-row"><span>SSID</span><strong>${esc(i.ssid || '—')}</strong></div>
      </div>
      <div class="iface-actions">
        ${i.wireless ? (isMonitor
          ? `<button class="btn btn-ghost btn-sm" data-action="iface-monitor" data-name="${esc(i.name)}" data-op="stop">${icon('wifi')} Modo managed</button>`
          : `<button class="btn btn-soft btn-sm" data-action="iface-monitor" data-name="${esc(i.name)}" data-op="start">${icon('radio')} Modo monitor</button>`)
          : ''}
        ${isMonitor ? `<button class="btn btn-accent btn-sm" data-action="iface-scan" data-name="${esc(i.name)}">${icon('radar')} Escanear</button>` : ''}
      </div>
    </div>`;
  }

  // ── Historial ────────────────────────────────────────────────────────────

  function history(state) {
    const eventsRaw = state.events || [];
    const historySearch = (state.historySearch || '').toLowerCase();
    const historyFilterType = state.historyFilterType || 'all';
    const events = eventsRaw.filter(function(ev) {
      if (historyFilterType !== 'all' && ev.type !== historyFilterType) return false;
      if (historySearch && !(ev.message || '').toLowerCase().includes(historySearch) && !(ev.detail || '').toLowerCase().includes(historySearch)) return false;
      return true;
    });
    const captures = state.captures || [];
    return `
      ${pageIntro(
        'Historial y capturas',
        'Registro de acciones de la sesión y archivos de captura encontrados en el sistema.',
        `<div class="search-wrap"><input class="input" id="historySearch" type="search" placeholder="Buscar en historial…" value="${esc(state.historySearch || '')}" autocomplete="off"></div>
         <select class="select" data-action="history-filter-type">
           <option value="all"${(state.historyFilterType || 'all') === 'all' ? ' selected' : ''}>Todos</option>
           <option value="success"${state.historyFilterType === 'success' ? ' selected' : ''}>Éxito</option>
           <option value="error"${state.historyFilterType === 'error' ? ' selected' : ''}>Error</option>
           <option value="warn"${state.historyFilterType === 'warn' ? ' selected' : ''}>Aviso</option>
           <option value="action"${state.historyFilterType === 'action' ? ' selected' : ''}>Acción</option>
           <option value="scan"${state.historyFilterType === 'scan' ? ' selected' : ''}>Escaneo</option>
         </select>
         <button class="btn btn-ghost" data-action="console-download">${icon('download')} Descargar log</button>
         <button class="btn btn-ghost" data-action="history-clear">${icon('eraser')} Limpiar historial</button>`
      )}
      <div class="dash-grid">
        <div>
          ${sectionTitle('activity', `Actividad (${events.length})`)}
          <div class="card card-pad">
            ${events.length ? `<div class="history-list">${events.map((ev) => `
              <div class="history-item">
                <span class="history-ico tone-${tone(ev.type === 'warn' ? 'amber' : ev.type === 'error' ? 'red' : ev.type === 'success' ? 'green' : 'blue')}">${icon(eventIcon(ev.type))}</span>
                <div class="history-copy">
                  <strong>${esc(ev.message)}</strong>
                  ${ev.detail ? `<span>${esc(ev.detail)}</span>` : ''}
                </div>
                <span class="history-time">${esc(clockTime(ev.ts))}</span>
              </div>`).join('')}</div>`
              : emptyState('activity', 'Sin actividad', 'Las acciones que realices aparecerán en este historial.')}
          </div>
        </div>
        <div>
          ${sectionTitle('file-key', `Capturas (${captures.length})`)}
          <div class="card card-pad">
            ${captures.length ? `<div class="file-list">${captures.map((f) => `
              <div class="file-item">
                ${icon('file')}
                <div class="file-copy"><strong>${esc(f.name)}</strong><span>${esc(f.path)}</span></div>
                <span class="file-size">${esc(formatBytes(f.size))}</span>
                <div class="file-actions">
                  <button class="icon-btn xs" data-action="file-copy-path" data-path="${esc(f.path)}" title="Copiar ruta">${icon('copy')}</button>
                </div>
              </div>`).join('')}</div>`
              : emptyState('file-key', 'Sin capturas', 'Los archivos .cap, .pcap y .22000 aparecerán aquí.')}
          </div>
        </div>
      </div>`;
  }

  // ── Configuración ────────────────────────────────────────────────────────

  function config(state) {
    const values = state.config || {};
    const search = (state.configSearch || '').toLowerCase();
    const groups = {};
    for (const def of AG.data.configDefs || []) {
      if (!(def.key in values)) continue;
      if (search && !def.label.toLowerCase().includes(search) && !def.key.toLowerCase().includes(search) && !(def.desc || '').toLowerCase().includes(search)) continue;
      (groups[def.group] = groups[def.group] || []).push(def);
    }
    const known = new Set((AG.data.configDefs || []).map((d) => d.key));
    const extra = Object.keys(values).filter((k) => !known.has(k));

    const groupHTML = Object.entries(groups).map(([group, defs]) => `
      ${sectionTitle('sliders-horizontal', group)}
      <div class="cfg-list">
        ${defs.map((def) => cfgItem(def, values[def.key])).join('')}
      </div>`).join('');

    return `
      ${pageIntro(
        'Configuración',
        'Ajustes de .airgeddonrc. Los cambios se guardan al instante y se crea una copia de seguridad la primera vez.',
        `<div class="search-wrap"><input class="input" id="configSearch" type="search" placeholder="Buscar configuración…" value="${esc(state.configSearch || '')}" autocomplete="off"></div>
         <button class="btn btn-ghost" data-action="config-refresh">${icon('refresh-cw')} Recargar</button>
         <button class="btn btn-ghost" data-action="config-raw">${icon('file-code')} Ver archivo</button>
         <button class="btn btn-ghost" data-action="config-export">${icon('download')} Exportar</button>
         <button class="btn btn-ghost" data-action="config-import">${icon('upload')} Importar</button>`
      )}
      ${sectionTitle('palette', 'Apariencia')}
      <div class="cfg-list">
        <div class="cfg-item">
          <div class="cfg-copy">
            <strong>Tema de la interfaz</strong>
            <span>Selecciona el tema visual de la GUI.</span>
            <span class="cfg-key">THEME</span>
          </div>
          <select class="select" data-action="theme-select">
            <option value="dark"${(document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? ' selected' : ''}>Oscuro</option>
            <option value="light"${(document.documentElement.getAttribute('data-theme') || 'dark') === 'light' ? ' selected' : ''}>Claro</option>
          </select>
        </div>
        <div class="cfg-item">
          <div class="cfg-copy">
            <strong>Tamaño de fuente de consola</strong>
            <span>Ajusta el tamaño de fuente de la terminal.</span>
            <span class="cfg-key">CONSOLE_FONT_SIZE</span>
          </div>
          <input type="range" min="8" max="24" value="${AG.terminal.getFontSize()}" class="range-input" data-action="console-font-size">
          <span class="badge slate">${AG.terminal.getFontSize()}px</span>
        </div>
        <div class="cfg-item">
          <div class="cfg-copy">
            <strong>Sonidos</strong>
            <span>Reproducir sonidos para eventos.</span>
            <span class="cfg-key">SOUND</span>
          </div>
          <button class="toggle${localStorage.getItem('ag-sound') !== 'off' ? ' on' : ''}" type="button" role="switch"
            data-action="config-toggle" data-key="SOUND" data-value="${localStorage.getItem('ag-sound') !== 'off' ? 'off' : 'on'}" aria-label="Sonidos"></button>
        </div>
      </div>

      ${sectionTitle('download', 'Actualizaciones y Aplicación')}
      <div class="cfg-list">
        <div class="cfg-item">
          <div class="cfg-copy">
            <strong>Estado de airgeddon GUI</strong>
            <span id="update-status-desc">Comprueba si hay nuevas versiones o mejoras del repositorio.</span>
            <span class="cfg-key" id="update-status-text">v2.0.0 (Modo Aplicación Linux)</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-ghost" data-action="check-updates">${icon('refresh-cw')} Comprobar</button>
            <button class="btn btn-primary" data-action="apply-updates" id="btn-apply-updates" style="display:none">${icon('download')} Actualizar ahora</button>
          </div>
        </div>
        <div class="cfg-item">
          <div class="cfg-copy">
            <strong>Lanzador de Escritorio</strong>
            <span>Acceso directo en el menú de aplicaciones de tu distribución (KDE, GNOME, XFCE…).</span>
            <span class="cfg-key">~/.local/share/applications/airgeddon-gui.desktop</span>
          </div>
          <span class="badge green">Instalado</span>
        </div>
      </div>

      ${groupHTML}
      ${extra.length ? `
        ${sectionTitle('file-code', 'Otras claves')}
        <div class="cfg-list">
          ${extra.map((key) => `<div class="cfg-item">
            <div class="cfg-copy"><strong>${esc(key)}</strong><span class="cfg-key">${esc(key)}</span></div>
            <input class="input" style="width:220px" value="${esc(values[key])}" data-action="config-input" data-key="${esc(key)}">
          </div>`).join('')}
        </div>` : ''}
      <div class="detail-note" style="margin-top:18px">${icon('info')}
        <div>Los cambios se aplican la próxima vez que inicies airgeddon. Si algo falla, se conserva una copia en <span class="mono">.airgeddonrc.gui-backup</span>.</div>
      </div>`;
  }

  function cfgItem(def, value) {
    const key = def.key;
    if (def.type === 'bool') {
      const on = String(value).toLowerCase() === 'true';
      return `<div class="cfg-item">
        <div class="cfg-copy">
          <strong>${esc(def.label)}</strong>
          <span>${esc(def.desc || '')}</span>
          <span class="cfg-key">${esc(key)}</span>
        </div>
        <button class="toggle${on ? ' on' : ''}" type="button" role="switch" aria-checked="${on}"
          data-action="config-toggle" data-key="${esc(key)}" data-value="${on ? 'false' : 'true'}" aria-label="${esc(def.label)}"></button>
      </div>`;
    }
    if (def.type === 'select') {
      return `<div class="cfg-item">
        <div class="cfg-copy">
          <strong>${esc(def.label)}</strong>
          <span>${esc(def.desc || '')}</span>
          <span class="cfg-key">${esc(key)}</span>
        </div>
        <select class="select" data-action="config-select" data-key="${esc(key)}">
          ${(def.options || []).map((opt) => `<option value="${esc(opt)}"${String(value) === String(opt) ? ' selected' : ''}>${esc(opt)}</option>`).join('')}
        </select>
      </div>`;
    }
    return `<div class="cfg-item">
      <div class="cfg-copy"><strong>${esc(def.label)}</strong><span>${esc(def.desc || '')}</span><span class="cfg-key">${esc(key)}</span></div>
      <input class="input" style="width:220px" value="${esc(value)}" data-action="config-input" data-key="${esc(key)}">
    </div>`;
  }

  // ── Diagnóstico ──────────────────────────────────────────────────────────

  function diagnostics(state) {
    const diag = state.diagnostics;
    if (!diag) {
      return `${pageIntro('Diagnóstico', 'Comprobación del sistema y de las herramientas de auditoría.')}
        ${emptyState('stethoscope', 'Cargando diagnóstico…', 'Se están comprobando las herramientas instaladas.', `<button class="btn btn-accent" data-action="diag-refresh">${icon('refresh-cw')} Recargar</button>`)}`;
    }
    const sys = diag.system || {};
    const ag = diag.airgeddon || {};
    const sudo = diag.sudo || {};
    const tools = diag.tools || [];
    const installed = tools.filter((t) => t.installed);
    const missing = tools.filter((t) => !t.installed);

    return `
      ${pageIntro(
        'Diagnóstico',
        'Estado del sistema, de airgeddon y de las herramientas externas que usan las auditorías.',
        `<button class="btn btn-ghost" data-action="diag-refresh">${icon('refresh-cw')} Actualizar</button>`
      )}
      <div class="info-grid">
        <div class="info-card">
          <h4>Sistema</h4>
          <div class="info-row"><span>Equipo</span><strong>${esc(sys.hostname || '—')}</strong></div>
          <div class="info-row"><span>Plataforma</span><strong>${esc(sys.platform || '—')} ${esc(sys.arch || '')}</strong></div>
          <div class="info-row"><span>Kernel</span><strong>${esc(sys.release || '—')}</strong></div>
          <div class="info-row"><span>CPU / RAM</span><strong>${esc(sys.cpus || '—')} · ${esc(formatBytes(sys.memory))}</strong></div>
          <div class="info-row"><span>Node</span><strong>${esc(sys.node || '—')}</strong></div>
        </div>
        <div class="info-card">
          <h4>airgeddon</h4>
          <div class="info-row"><span>Versión</span><strong>v${esc(ag.version || '—')}</strong></div>
          <div class="info-row"><span>Script</span><strong>${ag.exists ? 'encontrado' : 'no encontrado'}</strong></div>
          <div class="info-row"><span>.airgeddonrc</span><strong>${ag.rcExists ? 'presente' : 'ausente'}</strong></div>
          <div class="info-row"><span>Directorio</span><strong style="max-width:170px;overflow:hidden;text-overflow:ellipsis">${esc(ag.dir || '—')}</strong></div>
        </div>
        <div class="info-card">
          <h4>Permisos</h4>
          <div class="info-row"><span>sudo sin contraseña</span><strong>${sudo.passwordless ? 'sí' : 'no'}</strong></div>
          <div class="info-row"><span>Sesión autenticada</span><strong>${sudo.authenticated ? 'sí' : 'no'}</strong></div>
          <div class="info-row"><span>Herramientas</span><strong>${installed.length}/${tools.length}</strong></div>
        </div>
      </div>

      ${sectionTitle('wrench', `Herramientas instaladas (${installed.length})`)}
      <div class="tool-grid">
        ${installed.map((t) => `<div class="tool-item ok">${icon('check-circle-2')}<strong>${esc(t.name)}</strong><span>ok</span></div>`).join('')}
      </div>

      ${missing.length ? `
        ${sectionTitle('alert-triangle', `Faltantes (${missing.length})`)}
        <div class="tool-grid">
          ${missing.map((t) => `<div class="tool-item missing">${icon('x-circle')}<strong>${esc(t.name)}</strong><span>falta</span></div>`).join('')}
        </div>` : ''}

      ${sectionTitle('external-link', 'Herramientas externas')}
      <div class="external-tools">
        <button class="btn btn-ghost btn-sm" data-action="open-wireshark">${icon('external-link')} Wireshark</button>
        <button class="btn btn-ghost btn-sm" data-action="open-hashcat">${icon('external-link')} Hashcat</button>
        <button class="btn btn-ghost btn-sm" data-action="open-terminal">${icon('terminal')} Terminal del sistema</button>
      </div>`;
  }

  // ── Router ───────────────────────────────────────────────────────────────

  const renderers = { dashboard, audits, networks, interfaces, history, config, diagnostics };

  function render(name, state) {
    const fn = renderers[name] || dashboard;
    return fn(state);
  }

  return { render, dashboard, audits, networks, interfaces, history, config, diagnostics };
})();
