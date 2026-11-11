'use strict';

window.AG = window.AG || {};

AG.ui = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icons(root = document) {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons({ root }); } catch { try { window.lucide.createIcons(); } catch {} }
    }
  }

  function setHTML(el, html) {
    if (!el) return;
    el.innerHTML = html;
    icons(el);
  }

  function icon(name, cls = '') {
    return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''}></i>`;
  }

  function tone(color) {
    const allowed = ['teal', 'green', 'red', 'amber', 'blue', 'purple', 'pink', 'slate'];
    return allowed.includes(color) ? color : 'slate';
  }

  function notify(title, body, icon = '') {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: icon || undefined }); } catch {}
    }
  }

  function playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const freq = type === 'success' ? 880 : type === 'error' ? 220 : type === 'warn' ? 440 : 660;
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }

  function toast(message, type = 'info', title = '') {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const iconsByType = { success: 'check-circle-2', error: 'alert-circle', warn: 'alert-triangle', info: 'info' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${icon(iconsByType[type] || 'info')}
      <div class="toast-copy">${title ? `<strong>${esc(title)}</strong>` : ''}<span>${esc(message)}</span></div>`;
    root.appendChild(el);
    if (localStorage.getItem('ag-sound') !== 'off') playSound(type);
    icons(el);
    const life = type === 'error' ? 6000 : 3800;
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }, life);
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function timeAgo(ts) {
    const diff = Date.now() - Number(ts || 0);
    if (diff < 5000) return 'ahora';
    if (diff < 60000) return `hace ${Math.floor(diff / 1000)}s`;
    if (diff < 3600000) return `hace ${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)}h`;
    return new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }

  function clockTime(ts = Date.now()) {
    return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function shortDate(ts) {
    return new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function signalBars(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const q = p >= 75 ? 'q4' : p >= 50 ? 'q3' : p >= 25 ? 'q2' : 'q1';
    return `<span class="signal"><span class="signal-bars ${q}"><i></i><i></i><i></i><i></i></span><span class="signal-val">${p}%</span></span>`;
  }

  function encClass(kind) {
    return ['wpa2', 'wpa3', 'wpa', 'wep', 'open'].includes(kind) ? kind : 'other';
  }

  function debounce(fn, wait = 120) {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  async function copyText(text) {
    const value = String(text == null ? '' : text);
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function download(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * Modal genérico.
   * @returns {{el:HTMLElement, backdrop:HTMLElement, body:HTMLElement, head:HTMLElement, foot:HTMLElement|null, close:Function}}
   */
  function modal(opts = {}) {
    const root = document.getElementById('modalRoot');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('div');
    panel.className = `modal ${opts.size || ''} ${opts.className || ''}`.trim();
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    if (opts.title) panel.setAttribute('aria-label', opts.title);

    const color = tone(opts.color || 'teal');
    const head = document.createElement('div');
    head.className = `modal-head${opts.icon ? ' has-tone' : ''}`;
    head.style.setProperty('--tone-bg', `var(--${color}-soft)`);
    head.innerHTML = `
      ${opts.icon ? `<div class="modal-kicker"><span class="ctx-ico tone-${color}">${icon(opts.icon)}</span>${esc(opts.kicker || 'airgeddon')}</div>` : ''}
      <h2>${esc(opts.title || '')}</h2>
      ${opts.subtitle ? `<p>${esc(opts.subtitle)}</p>` : ''}
      ${opts.dismissible === false ? '' : `<button class="modal-close" type="button" aria-label="Cerrar">${icon('x')}</button>`}
    `;

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (opts.body != null) body.innerHTML = opts.body;

    let foot = null;
    if (opts.footer != null) {
      foot = document.createElement('div');
      foot.className = 'modal-foot';
      foot.innerHTML = opts.footer;
    }

    panel.appendChild(head);
    panel.appendChild(body);
    if (foot) panel.appendChild(foot);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    icons(backdrop);

    let closed = false;
    function close(result = null) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (typeof opts.onClose === 'function') opts.onClose(result);
    }

    function onKey(e) {
      if (e.key === 'Escape' && opts.dismissible !== false) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    }
    document.addEventListener('keydown', onKey, true);

    const closeBtn = head.querySelector('.modal-close');
    if (closeBtn) closeBtn.addEventListener('click', () => close(null));
    if (opts.dismissible !== false) {
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) close(null);
      });
    }

    const handle = { el: panel, backdrop, body, head, foot, close };
    if (typeof opts.onMount === 'function') opts.onMount(handle);
    setTimeout(() => {
      const focusTarget = panel.querySelector('[autofocus], input, select, textarea, button');
      if (focusTarget) {
        try { focusTarget.focus(); } catch {}
      }
    }, 40);
    return handle;
  }

  function confirm(opts = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const color = opts.danger ? 'red' : (opts.color || 'amber');
      let handle;
      handle = modal({
        size: 'narrow',
        title: opts.title || '¿Confirmar acción?',
        icon: opts.icon || 'alert-triangle',
        color,
        kicker: opts.kicker || 'Confirmación',
        body: `<div class="confirm-box">
            <div class="confirm-ico" style="background:var(--${color}-soft);color:var(--${color})">${icon(opts.icon || 'alert-triangle')}</div>
            <div><p>${esc(opts.message || '')}</p>${opts.detail ? `<small>${esc(opts.detail)}</small>` : ''}</div>
          </div>`,
        footer: `<div class="modal-actions">
            <button class="btn btn-ghost" data-confirm="0">${esc(opts.cancelLabel || 'Cancelar')}</button>
            <button class="btn ${opts.danger ? 'btn-danger' : (opts.confirmClass || 'btn-accent')}" data-confirm="1">${esc(opts.confirmLabel || 'Confirmar')}</button>
          </div>`,
        onClose: () => finish(false),
        onMount: ({ el }) => {
          el.querySelectorAll('[data-confirm]').forEach((btn) => {
            btn.addEventListener('click', () => {
              finish(btn.dataset.confirm === '1');
              handle.close();
            });
          });
        },
      });
    });
  }

  return {
    $, $$, esc, icons, setHTML, icon, tone, toast, notify, playSound,
    formatBytes, formatDuration, timeAgo, clockTime, shortDate,
    signalBars, encClass, debounce, copyText, download, modal, confirm,
  };
})();
