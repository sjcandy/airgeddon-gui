'use strict';

window.AG = window.AG || {};

AG.i18n = (() => {
  const translations = {
    es: {
      'app.title': 'airgeddon GUI',
      'nav.dashboard': 'Panel',
      'nav.audits': 'Auditorías',
      'nav.networks': 'Redes',
      'nav.interfaces': 'Interfaces',
      'nav.history': 'Historial',
      'nav.config': 'Configuración',
      'nav.diagnostics': 'Diagnóstico',
      'btn.start': 'Iniciar',
      'btn.stop': 'Detener',
      'btn.cancel': 'Cancelar',
      'btn.save': 'Guardar',
      'btn.close': 'Cerrar',
      'btn.refresh': 'Actualizar',
      'status.running': 'En ejecución',
      'status.stopped': 'Detenido',
      'status.idle': 'Inactivo',
    },
    en: {
      'app.title': 'airgeddon GUI',
      'nav.dashboard': 'Dashboard',
      'nav.audits': 'Audits',
      'nav.networks': 'Networks',
      'nav.interfaces': 'Interfaces',
      'nav.history': 'History',
      'nav.config': 'Configuration',
      'nav.diagnostics': 'Diagnostics',
      'btn.start': 'Start',
      'btn.stop': 'Stop',
      'btn.cancel': 'Cancel',
      'btn.save': 'Save',
      'btn.close': 'Close',
      'btn.refresh': 'Refresh',
      'status.running': 'Running',
      'status.stopped': 'Stopped',
      'status.idle': 'Idle',
    },
  };

  let currentLang = localStorage.getItem('ag-lang') || (navigator.language.startsWith('es') ? 'es' : 'en');

  function t(key) {
    const dict = translations[currentLang] || translations.es;
    return dict[key] || key;
  }

  function setLang(lang) {
    if (translations[lang]) {
      currentLang = lang;
      localStorage.setItem('ag-lang', lang);
    }
  }

  function getLang() {
    return currentLang;
  }

  function getAvailableLangs() {
    return Object.keys(translations);
  }

  return { t, setLang, getLang, getAvailableLangs };
})();
