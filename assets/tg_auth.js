// portal/assets/tg_auth.js
// Single source of truth for Telegram WebApp auth + apiFetch.

(function () {
  function getInitData() {
    try {
      const qs = new URLSearchParams(window.location.search);
      let v = qs.get('initData') || '';
      if (!v && window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
        v = window.Telegram.WebApp.initData;
      }
      return v || '';
    } catch (e) {
      return '';
    }
  }

  function withInitDataHeaders(headers) {
    const h = headers ? { ...headers } : {};
    const initData = getInitData();
    if (initData) h['X-TG-INITDATA'] = initData;
    return h;
  }

  async function apiFetch(url, options) {
    const opts = { ...(options || {}) };
    opts.credentials = 'include';
    opts.headers = withInitDataHeaders(opts.headers || {});

    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text.slice(0, 500) }; }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // expose
  window.portalAuth = {
    getInitData,
    withInitDataHeaders,
    apiFetch,
  };
})();
