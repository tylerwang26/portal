import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WebSocketClient } from '@fugle/marketdata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const WORKSPACE = '/home/node/.openclaw/workspace';
const ALLOWED_USER_ID = 549227213; // Tyler
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FUGLE_API_KEY = process.env.FUGLE_API_KEY;

const STATIC_TOKEN = process.env.STATIC_PORTAL_TOKEN || 'T628_TYLER_SAFE_ACCESS';

app.use(express.static(__dirname));

let signalsState = {
    updatedAt: new Date().toISOString(),
    competition: [],
    longterm: []
};

// --- Market Hours Logic ---
function isMarketOpen(market) {
    const now = new Date();
    if (market === 'TW') {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false });
        const parts = formatter.formatToParts(now);
        const t = {}; parts.forEach(p => t[p.type] = p.value);
        const hour = parseInt(t.hour);
        const min = parseInt(t.minute);
        if (t.weekday === 'Sat' || t.weekday === 'Sun') return false;
        return (hour >= 9 && (hour < 13 || (hour === 13 && min <= 35)));
    }
    if (market === 'US') {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false });
        const parts = formatter.formatToParts(now);
        const t = {}; parts.forEach(p => t[p.type] = p.value);
        const hour = parseInt(t.hour);
        const min = parseInt(t.minute);
        if (t.weekday === 'Sat' || t.weekday === 'Sun') return false;
        // US Market: 09:30 - 16:00 ET
        return (hour > 9 || (hour === 9 && min >= 30)) && (hour < 16);
    }
    return false;
}

// --- Fugle WebSocket Integration ---
let fugleClient;
let twWsActive = false;

async function initFugleWebSocket() {
    if (!FUGLE_API_KEY) return;
    try {
        if (fugleClient) {
            try { fugleClient.stock.disconnect(); } catch(e) {}
        }
        fugleClient = new WebSocketClient({ apiKey: FUGLE_API_KEY });
        const stock = fugleClient.stock;

        stock.on('open', () => {
            console.log('[Fugle WS] Connected.');
            twWsActive = true;
        });
        stock.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.event === 'data' && data.data) {
                    const { symbol, price } = data.data;
                    if (price) updatePriceInState(symbol, price);
                }
            } catch (e) {}
        });
        stock.on('error', (err) => {
            console.error('[Fugle WS] Error:', err);
            twWsActive = false;
        });
        stock.on('close', () => {
            console.log('[Fugle WS] Closed.');
            twWsActive = false;
        });

        await stock.connect();
        
        const allItems = [...signalsState.competition, ...signalsState.longterm];
        const twSymbols = allItems.filter(i => /^\d{4,6}$/.test(i.symbol)).map(i => i.symbol);
        twSymbols.forEach(symbol => stock.subscribe({ channel: 'trades', symbol }));

    } catch (error) {
        console.error('[Fugle WS] Init failed:', error.message);
        twWsActive = false;
    }
}

function updatePriceInState(symbol, price) {
    let changed = false;
    const findAndUpdate = (list) => {
        const item = list.find(i => i.symbol === symbol);
        if (item && item.price !== price.toString()) {
            item.price = price.toString();
            changed = true;
        }
    };
    findAndUpdate(signalsState.competition);
    findAndUpdate(signalsState.longterm);
    if (changed) signalsState.updatedAt = new Date().toISOString();
}

// --- REST Logic ---

async function fetchFuglePrice(symbol) {
    try {
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quotes/${symbol}`;
        const res = await fetch(url, { headers: { 'X-API-KEY': FUGLE_API_KEY } });
        const data = await res.json();
        return data.lastPrice || data.close || null;
    } catch (e) { return null; }
}

async function fetchFugleSparkline(symbol) {
    try {
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles/${symbol}?timeframe=5`;
        const res = await fetch(url, { headers: { 'X-API-KEY': FUGLE_API_KEY } });
        const data = await res.json();
        if (data.data) return data.data.slice(-30).map(c => c.close);
    } catch (e) {}
    return [];
}

async function fetchUSData(symbols) {
    return new Promise((resolve) => {
        const py = spawn('python3', [path.join(__dirname, 'fetch_us_prices.py'), ...symbols]);
        let output = '';
        py.stdout.on('data', (data) => { output += data.toString(); });
        py.on('close', () => {
            try { resolve(JSON.parse(output)); } catch (e) { resolve({}); }
        });
    });
}

async function refreshPrices(force = false) {
    const twOpen = isMarketOpen('TW');
    const usOpen = isMarketOpen('US');

    console.log(`[Portal] Sync Loop (Force: ${force}, TW Open: ${twOpen}, US Open: ${usOpen})`);

    const allItems = [...signalsState.competition, ...signalsState.longterm];

    // 1. Taiwan Stocks
    if (twOpen || force) {
        if (twOpen && !twWsActive && !force) initFugleWebSocket(); // Auto-reconnect WS if open
        const twItems = allItems.filter(i => /^\d{4,6}$/.test(i.symbol));
        await Promise.all(twItems.map(async (item) => {
            if (force || !twWsActive) {
                const price = await fetchFuglePrice(item.symbol);
                if (price) item.price = price.toString();
            }
            if (force || new Date().getMinutes() % 5 === 0) {
                const hist = await fetchFugleSparkline(item.symbol);
                if (hist.length) item.sparkline = hist;
            }
        }));
    }

    // 2. US Stocks
    if (usOpen || force) {
        const usItems = allItems.filter(i => /^[A-Z^=]+$/.test(i.symbol));
        const usSymbols = usItems.map(i => i.symbol);
        if (usSymbols.length > 0) {
            const usData = await fetchUSData(usSymbols);
            usItems.forEach(item => {
                const d = usData[item.symbol];
                if (d && d.price) {
                    item.price = d.price.toString();
                    item.change = d.change;
                    if (d.sparkline && d.sparkline.length > 0) item.sparkline = d.sparkline;
                }
            });
        }
    }
    signalsState.updatedAt = new Date().toISOString();
}

async function initSignals() {
    try {
        const signalsPath = path.join(__dirname, 'signals.json');
        if (fs.existsSync(signalsPath)) {
            const data = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
            signalsState.competition = data.competition || [];
            signalsState.longterm = data.longterm || [];
            await refreshPrices(true);
            if (isMarketOpen('TW')) initFugleWebSocket();
        }
    } catch (e) {}
}

setInterval(() => refreshPrices(false), 30000);
initSignals();

app.get('/api/signals', (req, res) => res.json(signalsState));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/explorer', (req, res) => res.sendFile(path.join(__dirname, 'explorer.html')));
app.get('/viewer', (req, res) => res.sendFile(path.join(__dirname, 'viewer.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Portal server running on port ${PORT}`));
