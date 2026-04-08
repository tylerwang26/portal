import React, { useEffect, useState } from 'react';

const TG = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
const TG_INITDATA = TG ? TG.initData : '';

function token() {
  const p = new URLSearchParams(location.search);
  return p.get('token') || '';
}

function apiFetch(url, opts = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const u = `${url}${sep}_t=${Date.now()}`;
  const headers = { ...(opts.headers || {}), ...(TG_INITDATA ? { 'X-TG-INITDATA': TG_INITDATA } : {}) };
  return fetch(u, { ...opts, headers });
}

function fmtChg(s) {
  let t = (s || '').trim();
  if (!t) return { text: '0%', cls: 'flat' };
  if (t === 'N/A') return { text: 'N/A', cls: 'flat' };
  if (t === '0%') return { text: '0%', cls: 'flat' };
  if (t.includes('-')) return { text: t, cls: 'down' };
  if (!t.startsWith('+')) t = '+' + t;
  return { text: t, cls: 'up' };
}

function Sparkline({ points, cls }) {
  if (!points || points.length < 2) return <span style={{ opacity: 0.4, fontSize: 11 }}>—</span>;
  const w = 64, h = 22;
  const min = Math.min(...points), max = Math.max(...points);
  const r = (max - min) || 1;
  const coords = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / r) * h}`).join(' ');
  const stroke = (cls === 'up') ? 'var(--c-success)' : (cls === 'down' ? 'var(--c-danger)' : 'var(--c-muted)');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`}>
      <polyline points={coords} style={{ stroke }} />
    </svg>
  );
}

function Row({ s }) {
  const chg = fmtChg(s.change);
  const pillType = (s.type || 'wait');
  return (
    <tr className="tr">
      <td className="td" style={{ width: '46%' }}>
        <div className="sym">{s.symbol || ''}</div>
        {s.name ? <div className="name">{s.name}</div> : null}
      </td>
      <td className="td" style={{ width: '18%' }}>
        <div className={`price ${chg.cls}`}>{s.price ?? '-'}</div>
        <div className={`chg ${chg.cls}`}>{chg.text}</div>
      </td>
      <td className="td" style={{ width: '18%' }}>
        <Sparkline points={s.sparkline || []} cls={chg.cls} />
      </td>
      <td className="td" style={{ width: '18%', textAlign: 'right' }}>
        <span className={`pill ${pillType}`}>{s.action || '—'}</span>
      </td>
    </tr>
  );
}

function ClockLine() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  const now = new Date();
  const tw = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const utc = now.toLocaleString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return <div className="sub sub-right">{`UTC+8: ${tw}\nUTC: ${utc}`}</div>;
}

export default function App() {
  const [tab, setTab] = useState('watchlist');
  const [quotes, setQuotes] = useState(null);
  const [signals, setSignals] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  async function loadQuotes() {
    try {
      const res = await apiFetch('/api/market-quotes');
      const data = await res.json();
      setQuotes(data.quotes || []);
      setLastUpdate(Date.now());
    } catch {}
  }

  async function loadSignals() {
    try {
      const res = await apiFetch('/api/signals');
      const data = await res.json();
      setSignals({
        watchlist: data.competition || [],
        holdings: data.longterm || [],
      });
    } catch {}
  }

  useEffect(() => {
    loadQuotes();
    loadSignals();
    const q = setInterval(loadQuotes, 15000);
    const s = setInterval(loadSignals, 5000);
    return () => { clearInterval(q); clearInterval(s); };
  }, []);

  function close() {
    const t = token();
    location.href = t ? `/?token=${t}` : '/';
  }

  const active = tab === 'watchlist' ? (signals?.watchlist) : (signals?.holdings);

  return (
    <div>
      <div className="header">
        <div className="h-left">
          <div className="title">🦊 股票即時</div>
        </div>


        <div className="h-right">
          <ClockLine />
          <span className="badge">LIVE</span>
          <button className="btn" onClick={close} title="關閉">✕</button>
        </div>
      </div>

      <div className="tabs">
        <div className="tabs-left">
          <div className={`tab ${tab === 'watchlist' ? 'active' : ''}`} onClick={() => setTab('watchlist')}>Watchlist（迅狐）</div>
          <div className={`tab ${tab === 'holdings' ? 'active' : ''}`} onClick={() => setTab('holdings')}>Holdings（靈狐）</div>
        </div>
        <div className="tabs-right">
          <a className="linkbtn" href="/sentiment-radar">🧭 輿情風險雷達</a>
          <a className="linkbtn" href="https://finance.worldmonitor.app/" target="_blank" rel="noopener">🌍 World Monitor</a>
        </div>
      </div>

      <div className="section">
        <h2>市場行情</h2>
        <div className="scroll-x">
          <table className="table"><tbody>
            {quotes ? (quotes.length ? quotes.map((q, idx) => <Row key={q.symbol || idx} s={{ ...q, action: q.note || '—', type: 'wait' }} />) : <tr><td className="td"><div className="loading">（無資料）</div></td></tr>) : <tr><td className="td"><div className="loading">載入中…</div></td></tr>}
          </tbody></table>
        </div>
      </div>

      <div className="section">
        <h2>{tab === 'watchlist' ? '迅狐戰術 (Competition)' : '靈狐 V5 持倉'}</h2>
        <div className="scroll-x">
          <table className="table"><tbody>
            {active ? (active.length ? active.map((s, idx) => <Row key={s.symbol || idx} s={s} />) : <tr><td className="td"><div className="loading">（空）</div></td></tr>) : <tr><td className="td"><div className="loading">載入中…</div></td></tr>}
          </tbody></table>
        </div>
      </div>

      <div className="footer">
        Vite+React build · 更新：{lastUpdate ? new Date(lastUpdate).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—'}
      </div>
    </div>
  );
}
