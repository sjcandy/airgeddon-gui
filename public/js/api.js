'use strict';

window.AG = window.AG || {};

AG.api = (() => {
  async function request(method, url, body) {
    const opts = {
      method,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, opts);
    } catch (err) {
      const error = new Error('No se pudo conectar con el servidor');
      error.code = 'NETWORK';
      throw error;
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!response.ok) {
      const error = new Error((data && (data.error || data.message)) || `Error HTTP ${response.status}`);
      error.status = response.status;
      error.code = (data && data.code) || (response.status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR');
      error.data = data;
      throw error;
    }
    return data;
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body === undefined ? {} : body),
    put: (url, body) => request('PUT', url, body),
  };
})();
