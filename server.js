import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketClient } from '@fugle/marketdata';
import bcrypt from 'bcryptjs';
import { XMLParser } from 'fast-xml-parser';
import multer from 'multer';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const WORKSPACE = '/home/node/.openclaw/workspace';
const ALLOWED_USER_ID = 549227213; // Tyler
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FUGLE_API_KEY = process.env.FUGLE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const STATIC_TOKEN = process.env.STATIC_PORTAL_TOKEN || 'T628_TYLER_SAFE_ACCESS';
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || 'http://localhost:5050';
const VOICE_SERVER_TOKEN = process.env.VOICE_SERVER_TOKEN || STATIC_TOKEN;
const FILEEXPLORER_URL = (process.env.FILEEXPLORER_URL || '').replace(/\/$/, '');

// --- Auth Configuration ---
const AUTH_DB_PATH = path.join(WORKSPACE, '.portal_auth.json');
const RP_NAME = '靈狐 Portal';
const RP_ID = process.env.PORTAL_RP_ID || 'portal.zeabur.app';
const ORIGIN = process.env.PORTAL_ORIGIN || `https://${RP_ID}`;

function loadAuthDB() {
    try { return JSON.parse(fs.readFileSync(AUTH_DB_PATH, 'utf8')); }
    catch { return { users: {}, webauthnCredentials: [] }; }
}
function saveAuthDB(db) { fs.writeFileSync(AUTH_DB_PATH, JSON.stringify(db, null, 2)); }

// Ensure workspace directory exists (critical for fresh containers)
fs.mkdirSync(WORKSPACE, { recursive: true });

// Initialize default user if not exists
(function initAuth() {
    const db = loadAuthDB();
    if (!db.users || !db.users['tyler']) {
        db.users = db.users || {};
        db.users['tyler'] = { passwordHash: bcrypt.hashSync('234wersdf', 10) };
        db.webauthnCredentials = db.webauthnCredentials || [];
        saveAuthDB(db);
    }
})();

// Trust proxy (Zeabur reverse proxy)
app.set('trust proxy', 1);

// Persistent session secret
const SESSION_SECRET_PATH = path.join(WORKSPACE, '.session_secret');
let sessionSecret;
try { sessionSecret = fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim(); }
catch { sessionSecret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SESSION_SECRET_PATH, sessionSecret); }

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: 'lax',
    },
    proxy: true
}));

app.set('trust proxy', 1);
app.use(express.json())
// JSON parse error handler middleware - added by assistant
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    // log bad request details for debugging (non-sensitive)
    try {
      const fs = require('fs');
      const line = `${new Date().toISOString()} BAD_JSON from ${req.ip} headers=${JSON.stringify(req.headers)}\n`;
      fs.appendFileSync('/tmp/portal_bad_requests.log', line);
    } catch (e) { console.error('bad_json_log_failed', String(e)); }
    return res.status(400).json({ error: 'bad_json' });
  }
  next(err);
});

app.use(express.static(__dirname));
// Local vendor assets (avoid CDN blocking in Telegram/WebViews)
app.use('/vendor/katex', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist')));

// --- Auth Middleware ---
function requireAuth(req, res, next) {
    // Allow legacy token auth (for API calls from OpenClaw agent)
    const token = req.query.token || req.headers['x-portal-token'];
    if (token === STATIC_TOKEN) {
        if (req.session) { req.session.authenticated = true; req.session.username = 'tyler-token'; }
        return next();
    }
    // Allow Telegram WebApp auth (header or query)
    const tgInit = req.headers['x-tg-initdata'] || req.query.initData;
    if (tgInit) return next();
    // Session auth
    if (req.session && req.session.authenticated) return next();
    // Not authenticated
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
}

// --- Google OAuth (Web App) ---
// Requires a *Web application* OAuth client with redirect URI:
//   https://portal.zeabur.app/oauth/google/callback
// Store credentials at workspace/secrets/google_oauth_web.json (chmod 600)
// or via env GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
const GOOGLE_OAUTH_WEB_PATH = path.join(WORKSPACE, 'secrets/google_oauth_web.json');
function loadGoogleWebClient() {
    // env takes precedence
    if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
        return { client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(GOOGLE_OAUTH_WEB_PATH, 'utf-8'));
        // accept either {web:{...}} or flat
        const web = raw.web || raw;
        return { client_id: web.client_id, client_secret: web.client_secret };
    } catch { return null; }
}

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
];

app.get('/oauth/google/start', requireAuth, (req, res) => {
    const client = loadGoogleWebClient();
    if (!client?.client_id || !client?.client_secret) return res.status(500).send('Google OAuth web client missing');

    const state = crypto.randomBytes(16).toString('hex');
    if (req.session) req.session.googleOAuthState = state;

    const redirectUri = `${ORIGIN}/oauth/google/callback`;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', client.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('state', state);

    res.redirect(authUrl.toString());
});

app.get('/oauth/google/callback', requireAuth, async (req, res) => {
    try {
        const client = loadGoogleWebClient();
        if (!client?.client_id || !client?.client_secret) return res.status(500).send('Google OAuth web client missing');

        const code = (req.query.code || '').toString();
        const state = (req.query.state || '').toString();
        if (!code) return res.status(400).send('Missing code');
        if (req.session?.googleOAuthState && state !== req.session.googleOAuthState) return res.status(400).send('State mismatch');

        const redirectUri = `${ORIGIN}/oauth/google/callback`;
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: client.client_id,
                client_secret: client.client_secret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });

        const token = await tokenRes.json();
        if (!tokenRes.ok) return res.status(502).send(`Token exchange failed: ${JSON.stringify(token)}`);

        const outPath = path.join(WORKSPACE, 'secrets/google_oauth_token.json');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({
            ...token,
            acquired_at: new Date().toISOString(),
        }, null, 2));
        try { fs.chmodSync(outPath, 0o600); } catch {}

        if (req.session) delete req.session.googleOAuthState;
        res.send('✅ Google OAuth 完成。你可以關閉此頁，回到 Portal。');
    } catch (e) {
        res.status(500).send(String(e));
    }
});

// --- Google Calendar helper (token refresh) ---
const GOOGLE_OAUTH_TOKEN_PATH = path.join(WORKSPACE, 'secrets/google_oauth_token.json');
function loadGoogleToken() {
    try { return JSON.parse(fs.readFileSync(GOOGLE_OAUTH_TOKEN_PATH, 'utf-8')); }
    catch { return null; }
}
function saveGoogleToken(t) {
    fs.mkdirSync(path.dirname(GOOGLE_OAUTH_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(GOOGLE_OAUTH_TOKEN_PATH, JSON.stringify(t, null, 2));
    try { fs.chmodSync(GOOGLE_OAUTH_TOKEN_PATH, 0o600); } catch {}
}

// --- Internal webhook for system messages ---
// Usage: POST /internal/webhook with JSON { "key": "<STATIC_PORTAL_TOKEN>", "channel": "system", "message": "..." }
app.post('/internal/webhook', (req, res) => {
    const key = req.body?.key || req.headers['x-portal-token'];
    if (key !== STATIC_TOKEN) return res.status(403).json({ error: 'forbidden' });
    const channel = req.body.channel || req.query.channel || 'system';
    const message = req.body.message || req.body.text || '';
    if (!message) return res.status(400).json({ error: 'no message' });
    // Log system message to workspace logs
    try {
        const outPath = path.join(WORKSPACE, 'logs/portal_webhook.log');
        const now = new Date().toISOString();
        const payload = `${now} [${channel}] ${message}\n`;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.appendFileSync(outPath, payload);
        return res.json({ ok: true, channel, written: outPath });
    } catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});
async function getGoogleAccessToken({ forceRefresh = false } = {}) {
    const token = loadGoogleToken();
    if (!token?.access_token) throw new Error('Google OAuth token missing');

    const acquiredAt = token.acquired_at ? Date.parse(token.acquired_at) : null;
    const expiresInSec = Number(token.expires_in || 0);
    const now = Date.now();

    // If we don't know the acquisition time, and we have a refresh_token, prefer refresh
    // (access_token could already be expired even if present on disk).
    let stillValid = false;
    if (!forceRefresh) {
        if (acquiredAt && expiresInSec) {
            stillValid = (now < (acquiredAt + (expiresInSec - 60) * 1000));
        } else if (!token.refresh_token) {
            stillValid = true; // no refresh path; best-effort use
        }
    }

    if (stillValid) return token.access_token;
    if (!token.refresh_token) return token.access_token;

    const client = loadGoogleWebClient();
    if (!client?.client_id || !client?.client_secret) return token.access_token;

    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: client.client_id,
            client_secret: client.client_secret,
            refresh_token: token.refresh_token,
            grant_type: 'refresh_token',
        }),
    });

    const refreshed = await refreshRes.json();
    if (!refreshRes.ok || !refreshed?.access_token) return token.access_token;

    const merged = {
        ...token,
        ...refreshed,
        // keep refresh_token if Google doesn't return it
        refresh_token: refreshed.refresh_token || token.refresh_token,
        acquired_at: new Date().toISOString(),
    };
    saveGoogleToken(merged);
    return merged.access_token;
}

// --- Auth Routes (no auth required) ---
app.get('/login', (req, res) => {
    const nextUrl = (req.query.next || '').toString();
    if (req.session && req.session.authenticated) {
        if (nextUrl && nextUrl.startsWith('/')) return res.redirect(nextUrl);
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth/login', (req, res) => {
    const { username, password, next } = req.body || {};
    const db = loadAuthDB();
    const user = db.users[username];
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        return res.json({ ok: false, error: '使用者名稱或密碼錯誤' });
    }
    req.session.authenticated = true;
    req.session.username = username;
    const hasWebAuthn = db.webauthnCredentials && db.webauthnCredentials.length > 0;

    // Safe redirect (relative paths only)
    const nextUrl = (typeof next === 'string' && next.startsWith('/')) ? next : '/';
    res.json({ ok: true, redirect: nextUrl, hasWebAuthn });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Auth status endpoint for frontend to check login state
app.get('/api/auth/me', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.json({ ok: true, authenticated: true, username: req.session.username });
    } else {
        res.json({ ok: true, authenticated: false });
    }
});

app.get('/auth/webauthn/has-credential', (req, res) => {
    const db = loadAuthDB();
    res.json({ hasCredential: db.webauthnCredentials && db.webauthnCredentials.length > 0 });
});

// WebAuthn Registration (requires authenticated session)
app.post('/auth/webauthn/register-options', async (req, res) => {
    if (!req.session || !req.session.authenticated) return res.status(401).json({ error: 'Login first' });
    const db = loadAuthDB();
    const existingCreds = (db.webauthnCredentials || []).map(c => ({
        id: c.credentialID,
        type: 'public-key',
        transports: c.transports || [],
    }));
    try {
        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userName: req.session.username,
            userDisplayName: 'Tyler',
            attestationType: 'none',
            excludeCredentials: existingCreds,
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'preferred',
            },
        });
        req.session.currentChallenge = options.challenge;
        res.json(options);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/auth/webauthn/register-verify', async (req, res) => {
    if (!req.session || !req.session.authenticated) return res.status(401).json({ error: 'Login first' });
    try {
        const verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge: req.session.currentChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
        });
        if (verification.verified && verification.registrationInfo) {
            const { credential } = verification.registrationInfo;
            const db = loadAuthDB();
            db.webauthnCredentials = db.webauthnCredentials || [];
            db.webauthnCredentials.push({
                credentialID: credential.id,
                credentialPublicKey: Buffer.from(credential.publicKey).toString('base64'),
                counter: credential.counter,
                transports: req.body.response?.transports || [],
                createdAt: new Date().toISOString(),
            });
            saveAuthDB(db);
            delete req.session.currentChallenge;
            res.json({ ok: true });
        } else {
            res.json({ ok: false, error: 'Verification failed' });
        }
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// WebAuthn Authentication
app.post('/auth/webauthn/auth-options', async (req, res) => {
    const db = loadAuthDB();
    const creds = (db.webauthnCredentials || []).map(c => ({
        id: c.credentialID,
        type: 'public-key',
        transports: c.transports || [],
    }));
    try {
        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials: creds,
            userVerification: 'required',
        });
        req.session.currentChallenge = options.challenge;
        res.json(options);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/auth/webauthn/auth-verify', async (req, res) => {
    const db = loadAuthDB();
    const cred = (db.webauthnCredentials || []).find(c => c.credentialID === req.body.id);
    if (!cred) return res.json({ ok: false, error: 'Unknown credential' });
    try {
        const verification = await verifyAuthenticationResponse({
            response: req.body,
            expectedChallenge: req.session.currentChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
            credential: {
                id: cred.credentialID,
                publicKey: new Uint8Array(Buffer.from(cred.credentialPublicKey, 'base64')),
                counter: cred.counter,
                transports: cred.transports,
            },
        });
        if (verification.verified) {
            // Update counter
            cred.counter = verification.authenticationInfo.newCounter;
            saveAuthDB(db);
            req.session.authenticated = true;
            req.session.username = 'tyler';
            delete req.session.currentChallenge;
            res.json({ ok: true, redirect: '/' });
        } else {
            res.json({ ok: false, error: 'Verification failed' });
        }
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// --- Apply auth to all page routes ---

let signalsState = {
    updatedAt: new Date().toISOString(),
    competition: [],
    longterm: []
};

// --- Helper: Is individual US stock? ---
function isIndividualUSStock(symbol) {
    // Indices and futures usually have = or ^
    return /^[A-Z]+$/.test(symbol);
}

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
        return (hour > 9 || (hour === 9 && min >= 30)) && (hour < 16);
    }
    return false;
}

// --- Fugle WebSocket Integration ---
let fugleClient;
let twWsActive = false;
let twWsConnecting = false;

async function initFugleWebSocket() {
    if (!FUGLE_API_KEY) return;
    if (twWsConnecting) return;
    twWsConnecting = true;
    try {
        if (fugleClient) {
            try { fugleClient.stock.disconnect(); } catch(e) {}
        }
        fugleClient = new WebSocketClient({ apiKey: FUGLE_API_KEY });
        const stock = fugleClient.stock;

        stock.on('open', () => {
            console.log('[Fugle WS] Connected.');
            twWsActive = true;
            twWsConnecting = false;
        });
        stock.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.event === 'data' && data.data) {
                    const { symbol, price } = data.data;
                    if (price) updatePriceInState(symbol, price);
                }
            } catch (e) { console.error('[Fugle WS] message parse error', e?.message || e); }
        });
        stock.on('error', (err) => {
            console.error('[Fugle WS] Error:', err);
            twWsActive = false;
            twWsConnecting = false;
        });
        stock.on('close', () => {
            console.log('[Fugle WS] Closed.');
            twWsActive = false;
            twWsConnecting = false;
        });

        console.log('[Fugle WS] Connecting to Fugle WebSocket...');
        await stock.connect();
        console.log('[Fugle WS] connect() promise resolved');
        
        const allItems = [...signalsState.competition, ...signalsState.longterm];
        const twSymbols = allItems.filter(i => /^\d{4,6}$/.test(i.symbol)).map(i => i.symbol);
        twSymbols.forEach(symbol => {
            try { stock.subscribe({ channel: 'trades', symbol }); }
            catch (e) { console.error('[Fugle WS] subscribe failed for', symbol, e?.message || e); }
        });
        console.log('[Fugle WS] Subscribed to', twSymbols.length, 'symbols');

    } catch (error) {
        console.error('[Fugle WS] Init failed:', error.message || error);
        twWsActive = false;
        twWsConnecting = false;
    }
}

// --- Finnhub WebSocket Integration ---
let finnhubWs;
let usWsActive = false;
let usWsConnecting = false;

async function initFinnhubWebSocket() {
    if (!FINNHUB_API_KEY) return;
    if (usWsConnecting) return;
    usWsConnecting = true;
    try {
        if (finnhubWs) {
            try { finnhubWs.close(); } catch(e) {}
        }
        finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);

        finnhubWs.onopen = () => {
            console.log('[Finnhub WS] Connected.');
            usWsActive = true;
            usWsConnecting = false;
            const allItems = [...signalsState.competition, ...signalsState.longterm];
            const usStocks = allItems.filter(i => isIndividualUSStock(i.symbol)).map(i => i.symbol);
            usStocks.forEach(symbol => {
                try { finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol })); }
                catch (e) { console.error('[Finnhub WS] subscribe failed for', symbol, e?.message || e); }
            });
            console.log('[Finnhub WS] Subscribed to', usStocks.length, 'symbols');
        };

        finnhubWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'trade' && data.data) {
                    data.data.forEach(trade => {
                        const { s: symbol, p: price } = trade;
                        updatePriceInState(symbol, price);
                    });
                }
            } catch (e) { console.error('[Finnhub WS] onmessage parse error', e?.message || e); }
        };

        finnhubWs.onerror = (err) => {
            console.error('[Finnhub WS] Error:', err?.message || err);
            usWsActive = false;
            usWsConnecting = false;
        };

        finnhubWs.onclose = () => {
            console.log('[Finnhub WS] Closed.');
            usWsActive = false;
            usWsConnecting = false;
            // Attempt reconnect in 10s
            setTimeout(initFinnhubWebSocket, 10000);
        };

    } catch (error) {
        console.error('[Finnhub WS] Init failed:', error?.message || error);
        usWsActive = false;
        usWsConnecting = false;
    }
}

function updatePriceInState(symbol, price) {
    let changed = false;
    const findAndUpdate = (list) => {
        const item = list.find(i => i.symbol === symbol);
        if (item) {
            const pStr = price.toFixed(2);
            if (item.price !== pStr) {
                item.price = pStr;
                // Recalculate change if pc is available
                if (item.pc) {
                    const diff = price - item.pc;
                    const pct = (diff / item.pc) * 100;
                    item.change = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
                }
                changed = true;
            }
        }
    };
    findAndUpdate(signalsState.competition);
    findAndUpdate(signalsState.longterm);
    if (changed) signalsState.updatedAt = new Date().toISOString();
}

// --- Telegram Auth Middleware ---
function tgAuth(req, res, next) {
    const initData = req.headers['x-tg-initdata'] || req.query.initData;
    const urlToken = req.query.token;

    // Literal token auth (fallback for non-TG context)
    if (urlToken === STATIC_TOKEN) {
        // Generate compatible initData format for fallback
        const fallbackInitData = new URLSearchParams();
        fallbackInitData.set('user', JSON.stringify({
            id: ALLOWED_USER_ID,
            first_name: 'Tyler',
            username: 'tylerty6592',
            language_code: 'zh-TW'
        }));
        fallbackInitData.set('auth_date', Math.floor(Date.now() / 1000).toString());
        fallbackInitData.set('query_id', Date.now().toString(36) + Math.random().toString(36).substring(2));
        req.headers['x-tg-initdata'] = fallbackInitData.toString();
        req.initData = fallbackInitData.toString();
        return next();
    }

    // Accept session auth
    if (req.session && req.session.authenticated) return next();

    if (!initData) return res.status(401).json({ error: 'Missing auth' });
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server auth misconfigured' });
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (hmac !== hash) return res.status(403).json({ error: 'Invalid auth' });
        const user = JSON.parse(urlParams.get('user'));
        if (user.id !== ALLOWED_USER_ID) return res.status(403).json({ error: 'Unauthorized user' });
        next();
    } catch (e) { res.status(400).json({ error: 'Auth error' }); }
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
    if (!FINNHUB_API_KEY) return {};
    const results = {};
    for (const symbol of symbols) {
        try {
            const cleanSym = symbol.replace('.TW', '');
            const url = `https://finnhub.io/api/v1/quote?symbol=${cleanSym}&token=${FINNHUB_API_KEY}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data && data.c && data.c !== 0) {
                results[symbol] = {
                    price: data.c.toString(),
                    change: `${data.dp > 0 ? '+' : ''}${data.dp.toFixed(2)}%`,
                    pc: data.pc
                };
            }
            // Rate limiting safety delay (200ms)
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`[Portal] Error fetching US symbol ${symbol}:`, e.message);
        }
    }
    return results;
}

// Signal Handlers for Graceful Shutdown
const shutdown = () => {
    console.log('[Portal] Received termination signal. Shutting down gracefully...');
    if (fugleClient) {
        try { fugleClient.stock.disconnect(); } catch(e) {}
    }
    if (finnhubWs) {
        try { finnhubWs.close(); } catch(e) {}
    }
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function refreshPrices(force = false) {
    const twOpen = isMarketOpen('TW');
    const usOpen = isMarketOpen('US');

    const _syncStart = Date.now();
    console.log(`[Portal] Sync Loop START (Force: ${force}, TW Open: ${twOpen}, US Open: ${usOpen}, US WS: ${usWsActive})`);

    const allItems = [...signalsState.competition, ...signalsState.longterm];

    // 1. Process Taiwan Stocks
    const twItems = allItems.filter(i => /^\d{4,6}$/.test(i.symbol));
    if (twOpen || force) {
        if (twOpen && !twWsActive && !force && !twWsConnecting) {
            console.log('[Portal] TW WS not active; attempting initFugleWebSocket()');
            initFugleWebSocket();
        }
        await Promise.all(twItems.map(async (item) => {
            try {
                if (force || !twWsActive) {
                    const price = await fetchFuglePrice(item.symbol);
                    if (price) item.price = price.toString();
                }
                if (force || new Date().getMinutes() % 5 === 0) {
                    const hist = await fetchFugleSparkline(item.symbol);
                    if (hist.length) item.sparkline = hist;
                }
            } catch (e) {
                console.error('[Portal] Error processing TW item', item.symbol, e?.message || e);
            }
        }));
    }

    // 2. Process US Stocks (Hybrid Logic)
    if (usOpen || force) {
        if (usOpen && !usWsActive && !force) {
            console.log('[Portal] US WS not active; attempting initFinnhubWebSocket()');
            initFinnhubWebSocket();
        }
        const usItems = allItems.filter(i => /^[A-Z^=]+$/.test(i.symbol));
        
        // Symbols that MUST use REST (Indices, Futures, or if WS is down)
        const restSymbols = usItems.filter(i => force || !usWsActive || !isIndividualUSStock(i.symbol)).map(i => i.symbol);

        if (restSymbols.length > 0) {
            try {
                const usData = await fetchUSData(restSymbols);
                usItems.forEach(item => {
                    const d = usData[item.symbol];
                    if (d) {
                        if (d.price) item.price = d.price;
                        if (d.change) item.change = d.change;
                        if (d.pc) item.pc = d.pc; // Store prevClose for WS calculations
                    }
                });
            } catch (e) {
                console.error('[Portal] Error fetching US data for restSymbols', e?.message || e);
            }
        }
    }
    signalsState.updatedAt = new Date().toISOString();
    console.log(`[Portal] Sync Loop DONE (took ${Date.now() - _syncStart}ms)`);
}

async function initSignals() {
    try {
        const signalsPath = path.join(__dirname, 'signals.json');
        if (fs.existsSync(signalsPath)) {
            const data = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
            signalsState.competition = data.competition || [];
            signalsState.longterm = data.longterm || [];
            await refreshPrices(true);
            if (isMarketOpen('TW') && !twWsConnecting) initFugleWebSocket();
            if (isMarketOpen('US') && !usWsConnecting) initFinnhubWebSocket();
        }
    } catch (e) {}
}

setInterval(() => refreshPrices(false), 45000);
initSignals();
console.log('[Portal] Initialization sequence started.');

app.get('/api/signals', (req, res) => res.json(signalsState));

// --- 市場行情（Market Quotes）---
// NOTE (Tyler 2026-03-13): Stooq sources were unstable/invalid in practice.
// Strategy: prefer Fugle for TW (ETF proxy) and Finnhub for US (ETF proxy).
// If you want "true index" sources later, we can add TAIFEX + official index feeds.
const MARKET_QUOTES = [
    // TW (Fugle) — use liquid ETF proxies
    { symbol: '0050', name: '0050 元大台灣50（TAIEX Proxy）', source: 'fugle' },
    { symbol: '006208', name: '006208 富邦台50（TAIEX Proxy）', source: 'fugle' },

    // US (Finnhub) — ETF proxies
    { symbol: 'SPY', name: 'SPY（S&P 500 Proxy）', source: 'finnhub' },
    { symbol: 'QQQ', name: 'QQQ（NASDAQ 100 Proxy）', source: 'finnhub' },
    { symbol: 'DIA', name: 'DIA（Dow Jones Proxy）', source: 'finnhub' },
    { symbol: 'IWM', name: 'IWM（Russell 2000 Proxy）', source: 'finnhub' },
    { symbol: 'GLD', name: 'GLD（Gold Proxy）', source: 'finnhub' },

    // Placeholder
    { symbol: '台指期', name: '台指期', source: 'taifex', taifex: 'TXF', note: '待串接 TAIFEX 即時行情' }
];

async function fetchStooqQuote(stooqSymbol) {
    // Stooq quote (daily) CSV: SYMBOL,DATE,TIME,OPEN,HIGH,LOW,CLOSE,VOLUME
    const s = encodeURIComponent(stooqSymbol.toLowerCase());
    const url = `https://stooq.com/q/l/?s=${s}&i=d`;

    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`Stooq HTTP ${resp.status}`);

    const text = await resp.text();
    const line = (text || '').trim().split('\n').pop();
    const parts = line.split(',');
    if (parts.length < 8) return null;

    const open = parseFloat(parts[3]);
    const close = parseFloat(parts[6]);
    if (!isFinite(close)) return null;

    let change = '';
    if (isFinite(open) && open !== 0) {
        const pct = ((close - open) / open) * 100;
        change = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }

    return { symbol: parts[0], price: close.toString(), change };
}

app.get('/api/market-quotes', requireAuth, async (req, res) => {
    try {
        const quotes = [];

        // Batch fetch US quotes via Finnhub to reduce latency
        const usSymbols = MARKET_QUOTES.filter(q => q.source === 'finnhub').map(q => q.symbol);
        const usData = usSymbols.length ? await fetchUSData(usSymbols) : {};

        for (const q of MARKET_QUOTES) {
            if (q.source === 'fugle') {
                const price = await fetchFuglePrice(q.symbol);
                const sparkline = await fetchFugleSparkline(q.symbol);
                quotes.push({
                    symbol: q.symbol,
                    name: q.name,
                    price: price != null ? String(price) : '-',
                    change: '',
                    sparkline: sparkline || [],
                    note: '來源：Fugle'
                });
                continue;
            }

            if (q.source === 'finnhub') {
                const d = usData[q.symbol] || null;
                quotes.push({
                    symbol: q.symbol,
                    name: q.name,
                    price: d?.price || '-',
                    change: d?.change || '',
                    sparkline: [],
                    note: '來源：Finnhub'
                });
                continue;
            }

            // TAIFEX（台指期）暫未串：先回傳空值，避免誤導
            quotes.push({
                symbol: q.symbol,
                name: q.name,
                price: '-',
                change: '',
                sparkline: [],
                note: q.note || 'N/A'
            });
        }

        res.json({ updatedAt: new Date().toISOString(), quotes });
    } catch (e) {
        res.status(500).json({ error: e.message, quotes: [] });
    }
});

app.get('/api/voice-config', tgAuth, (req, res) => {
    const qsToken = req.query.token === STATIC_TOKEN ? `?token=${STATIC_TOKEN}` : '';
    res.json({
        voiceServer: VOICE_SERVER_URL,
        authToken: VOICE_SERVER_TOKEN,
        proxyTranscribe: `/api/voice-proxy/transcribe${qsToken}`,
        proxyTts: `/api/voice-proxy/tts${qsToken}`
    });
});

async function proxyVoiceRequest(req, res, voicePath) {
    try {
        const base = VOICE_SERVER_URL.endsWith('/') ? VOICE_SERVER_URL.slice(0, -1) : VOICE_SERVER_URL;
        const targetUrl = `${base}${voicePath}?token=${VOICE_SERVER_TOKEN}`;

        // Buffer the full request body first (needed for multipart)
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);

        const headers = {
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            'Content-Length': String(bodyBuffer.length),
        };

        const proxyRes = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: bodyBuffer,
        });

        res.status(proxyRes.status);
        proxyRes.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'transfer-encoding') return;
            res.setHeader(key, value);
        });
        const buffer = Buffer.from(await proxyRes.arrayBuffer());
        res.send(buffer);
    } catch (error) {
        console.error('[Portal] Voice proxy error:', error);
        res.status(502).json({ error: 'Voice proxy failed', detail: error.message });
    }
}

app.post('/api/voice-proxy/transcribe', tgAuth, (req, res) => proxyVoiceRequest(req, res, '/v1/transcribe'));

// /v1/tts expects JSON (Pydantic model), not multipart
app.post('/api/voice-proxy/tts', tgAuth, express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const base = VOICE_SERVER_URL.endsWith('/') ? VOICE_SERVER_URL.slice(0, -1) : VOICE_SERVER_URL;
        const proxyRes = await fetch(`${base}/v1/tts`, {
            method: 'POST',
            headers: {
                'X-Portal-Token': VOICE_SERVER_TOKEN,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body || {}),
        });

        res.status(proxyRes.status);
        proxyRes.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'transfer-encoding') return;
            res.setHeader(key, value);
        });
        const buffer = Buffer.from(await proxyRes.arrayBuffer());
        res.send(buffer);
    } catch (error) {
        console.error('[Portal] Voice proxy tts error:', error);
        res.status(502).json({ error: 'Voice proxy failed', detail: error.message });
    }
});

app.post('/api/voice-proxy/voice-chat', tgAuth, (req, res) => proxyVoiceRequest(req, res, '/v1/voice-chat'));
app.post('/api/voice-proxy/session/clear', tgAuth, (req, res) => proxyVoiceRequest(req, res, '/v1/session/clear'));

// SECURE API: List workspace files (proxy to fileexplorer service if configured)
app.get('/api/workspace/list', tgAuth, async (req, res) => {
    if (FILEEXPLORER_URL) {
        try {
            const q = new URLSearchParams({ path: req.query.path || '', token: STATIC_TOKEN });
            const r = await fetch(`${FILEEXPLORER_URL}/api/workspace/list?${q}`, {
                headers: { 'x-portal-token': STATIC_TOKEN }
            });
            const data = await r.json();
            if (!r.ok) return res.status(r.status).json(data);
            // Normalize fileexplorer response (items) to portal format (list)
            const list = (data.items || []).map(item => ({
                name: item.name,
                isFile: item.type === 'file',
                isDirectory: item.type === 'dir',
                path: (req.query.path ? req.query.path + '/' : '') + item.name,
                size: item.size || 0,
                mtime: item.mtime || 0, ctime: 0,
            }));
            return res.json({ list, currentPath: req.query.path || '' });
        } catch (e) { return res.status(502).json({ error: 'fileexplorer unavailable: ' + e.message }); }
    }
    const reqPath = req.query.path || '';
    const targetPath = path.normalize(path.join(WORKSPACE, reqPath));
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });
    try {
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Not found' });
        const stats = fs.statSync(targetPath);
        if (stats.isFile()) return res.json({ list: [{ name: path.basename(targetPath), isFile: true, path: reqPath, size: stats.size }] });
        const files = fs.readdirSync(targetPath).map(name => {
            const fpath = path.join(targetPath, name);
            const st = fs.statSync(fpath);
            return {
                name,
                isFile: st.isFile(),
                isDirectory: st.isDirectory(),
                path: reqPath ? reqPath + '/' + name : name,
                size: st.size,
                mtime: Number(st.mtimeMs || st.mtime || Date.parse(st.mtime) || 0),
                ctime: Number(st.ctimeMs || st.ctime || Date.parse(st.ctime) || 0)
            };
        });
        res.json({ list: files, currentPath: reqPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SECURE API: View file content (proxy to fileexplorer service if configured)
app.get('/api/workspace/view', tgAuth, async (req, res) => {
    if (FILEEXPLORER_URL) {
        try {
            const q = new URLSearchParams({ path: req.query.path || '', token: STATIC_TOKEN });
            const r = await fetch(`${FILEEXPLORER_URL}/api/workspace/view?${q}`, {
                headers: { 'x-portal-token': STATIC_TOKEN }
            });
            const data = await r.json();
            if (!r.ok) return res.status(r.status).json(data);
            // Normalize: fileexplorer returns { ok, content } → portal expects { content, path }
            return res.json({ content: data.content, path: req.query.path || '' });
        } catch (e) { return res.status(502).json({ error: 'fileexplorer unavailable: ' + e.message }); }
    }
    const reqPath = req.query.path || '';
    const targetPath = path.join(WORKSPACE, reqPath);
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });
    try {
        const content = fs.readFileSync(targetPath, 'utf-8');
        res.json({ content, path: reqPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SECURE API: Office preview (docx/pptx/xlsx -> markdown)
app.get('/api/office/preview', tgAuth, (req, res) => {
    const reqPath = req.query.path || '';
    const targetPath = path.join(WORKSPACE, reqPath);
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });

    try {
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Not found' });

        const scriptPath = path.join(WORKSPACE, 'scripts', 'office_preview.py');
        const venvPy = path.join(WORKSPACE, '.venv_voldrag', 'bin', 'python');
        const py = fs.existsSync(venvPy) ? venvPy : 'python3';

        const r = spawnSync(py, [scriptPath, targetPath], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
        });

        const out = (r.stdout || '').trim();
        if (r.status !== 0 && !out) {
            return res.status(500).json({ error: 'Office preview failed', detail: r.stderr || '' });
        }
        res.json({ ok: true, path: reqPath, content: out + '\n' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SECURE API: Save text content (used by Notes editor)
// Modified: allow .json editing under obsidian_vault/, with per-save timestamped backups
app.post('/api/workspace/save', tgAuth, express.json({ limit: '2mb' }), (req, res) => {
    const reqPath = (req.body && req.body.path) ? String(req.body.path) : '';
    const content = (req.body && typeof req.body.content === 'string') ? req.body.content : null;
    if (!reqPath) return res.status(400).json({ error: 'Missing path' });
    if (content === null) return res.status(400).json({ error: 'Missing content' });

    // Security: only allow editing within obsidian_vault (relative path)
    const rel = reqPath.replace(/\\\\/g, '/'); // normalize
    if (!rel.startsWith('obsidian_vault/')) return res.status(403).json({ error: 'Editing restricted to obsidian_vault' });

    // Only permit .md and .json files to be saved via this endpoint
    const ext = path.extname(rel).toLowerCase();
    if (!['.md', '.markdown', '.json', '.txt'].includes(ext)) return res.status(400).json({ error: 'Unsupported file type' });

    const targetPath = path.join(WORKSPACE, rel);
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });

    try {
        // Create backup dir and copy existing file (if any)
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(WORKSPACE, 'backups', 'portal_edits', ts);
        fs.mkdirSync(backupDir, { recursive: true });
        if (fs.existsSync(targetPath)) {
            const relBackupPath = path.join(backupDir, rel);
            fs.mkdirSync(path.dirname(relBackupPath), { recursive: true });
            fs.copyFileSync(targetPath, relBackupPath);
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf-8');

        // Preserve file mode where possible (best-effort)
        try {
            const st = fs.statSync(targetPath);
            fs.chmodSync(targetPath, st.mode);
        } catch (e) { /* ignore */ }

        res.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf-8'), backup: fs.existsSync(path.join(backupDir, rel)) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SECURE API: Delete file (Explorer swipe)
app.post('/api/workspace/delete', tgAuth, express.json({ limit: '256kb' }), (req, res) => {
    const reqPath = (req.body && req.body.path) ? String(req.body.path) : '';
    if (!reqPath) return res.status(400).json({ error: 'Missing path' });

    const targetPath = path.join(WORKSPACE, reqPath);
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });

    try {
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Not found' });
        const st = fs.statSync(targetPath);
        if (st.isDirectory()) return res.status(400).json({ error: 'Refuse to delete directory' });
        fs.unlinkSync(targetPath);

        // Best-effort: if deleted file was favorited, prune it from favorites immediately
        try {
            const favs = loadFavorites();
            const next = favs.filter(f => f.path !== reqPath);
            if (next.length !== favs.length) saveFavorites(next);
        } catch {}

        // Best-effort: update broken-links report for workspace markdown
        try {
            const { spawn } = require('child_process');
            const script = path.join(WORKSPACE, 'scripts', 'link_updater.py');
            spawn('python3', [script, '--delete', reqPath], { stdio: 'ignore', detached: true }).unref();
        } catch {}

        res.json({ ok: true, path: reqPath });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SECURE API: Upload files into a specific workspace folder (Explorer + button)
const uploadWs = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/workspace/upload', tgAuth, uploadWs.array('files', 20), (req, res) => {
    try {
        const dir = String(req.query.path || '');
        const targetDir = path.normalize(path.join(WORKSPACE, dir));
        if (!targetDir.startsWith(WORKSPACE)) return res.status(403).json({ ok: false, error: 'Access denied' });
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            return res.status(400).json({ ok: false, error: 'Target dir not found' });
        }
        if (!req.files || !req.files.length) return res.status(400).json({ ok: false, error: 'No files uploaded' });

        const saved = [];
        for (const file of req.files) {
            const filename = normalizeFilename(file.originalname);
            const outPath = path.join(targetDir, filename);
            fs.writeFileSync(outPath, file.buffer);
            saved.push({ name: filename, path: path.relative(WORKSPACE, outPath).replace(/\\/g, '/') });
        }

        res.json({ ok: true, dir, count: saved.length, saved });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// SECURE API: Create directory (Explorer folder + button)
app.post('/api/workspace/mkdir', tgAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
        const base = String(req.body?.path || '');
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ ok: false, error: 'Missing name' });
        if (name.includes('/') || name.includes('\\') || name.includes('..')) return res.status(400).json({ ok: false, error: 'Invalid name' });

        const baseAbs = path.normalize(path.join(WORKSPACE, base));
        if (!baseAbs.startsWith(WORKSPACE)) return res.status(403).json({ ok: false, error: 'Access denied' });
        if (!fs.existsSync(baseAbs) || !fs.statSync(baseAbs).isDirectory()) return res.status(400).json({ ok: false, error: 'Base dir not found' });

        const newDir = path.join(baseAbs, name);
        fs.mkdirSync(newDir, { recursive: true });
        res.json({ ok: true, path: path.relative(WORKSPACE, newDir).replace(/\\/g, '/') });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// SECURE API: Move file/folder within workspace (Explorer drag & drop)
app.post('/api/workspace/move', tgAuth, express.json({ limit: '256kb' }), (req, res) => {
    try {
        const from = String(req.body?.from || '');
        const toDir = String(req.body?.toDir || '');
        if (!from || !toDir) return res.status(400).json({ ok: false, error: 'Missing from/toDir' });

        const absFrom = path.normalize(path.join(WORKSPACE, from));
        const absToDir = path.normalize(path.join(WORKSPACE, toDir));
        if (!absFrom.startsWith(WORKSPACE) || !absToDir.startsWith(WORKSPACE)) return res.status(403).json({ ok: false, error: 'Access denied' });
        if (!fs.existsSync(absFrom)) return res.status(404).json({ ok: false, error: 'Source not found' });
        if (!fs.existsSync(absToDir) || !fs.statSync(absToDir).isDirectory()) return res.status(400).json({ ok: false, error: 'Target must be directory' });

        const base = path.basename(absFrom);
        const absTo = path.join(absToDir, base);
        if (absTo.startsWith(absFrom + path.sep)) return res.status(400).json({ ok: false, error: 'Refuse to move into itself' });

        fs.renameSync(absFrom, absTo);
        const toRel = path.relative(WORKSPACE, absTo).replace(/\\/g, '/');

        // Best-effort: update markdown links for workspace
        try {
            const { spawn } = require('child_process');
            const script = path.join(WORKSPACE, 'scripts', 'link_updater.py');
            spawn('python3', [script, '--move', from, toRel], { stdio: 'ignore', detached: true }).unref();
        } catch {}

        res.json({ ok: true, from, to: toRel });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// SECURE API: Rename file within its directory (Explorer)
app.post('/api/workspace/rename', tgAuth, express.json({ limit: '256kb' }), (req, res) => {
    try {
        const reqPath = String(req.body?.path || '');
        const newName = String(req.body?.newName || '').trim();
        if (!reqPath || !newName) return res.status(400).json({ ok: false, error: 'Missing path/newName' });
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) return res.status(400).json({ ok: false, error: 'Invalid newName' });

        const absOld = path.normalize(path.join(WORKSPACE, reqPath));
        if (!absOld.startsWith(WORKSPACE)) return res.status(403).json({ ok: false, error: 'Access denied' });
        if (!fs.existsSync(absOld)) return res.status(404).json({ ok: false, error: 'Not found' });
        const st = fs.statSync(absOld);
        if (st.isDirectory()) return res.status(400).json({ ok: false, error: 'Refuse to rename directory (use move)' });

        const absDir = path.dirname(absOld);
        const absNew = path.join(absDir, newName);
        if (!absNew.startsWith(WORKSPACE)) return res.status(403).json({ ok: false, error: 'Access denied' });

        fs.renameSync(absOld, absNew);
        const toRel = path.relative(WORKSPACE, absNew).replace(/\\/g, '/');

        // Best-effort: update markdown links for workspace
        try {
            const { spawn } = require('child_process');
            const script = path.join(WORKSPACE, 'scripts', 'link_updater.py');
            spawn('python3', [script, '--move', reqPath, toRel], { stdio: 'ignore', detached: true }).unref();
        } catch {}

        res.json({ ok: true, from: reqPath, to: toRel });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// SECURE API: Raw file (images)
// SECURE API: Link summary (title/description) for clip-link
app.post('/api/link/summary', tgAuth, express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Invalid url' });

        // YouTube: use oEmbed
        if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
            const oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
            const r = await fetch(oembed, { timeout: 15000 });
            if (r.ok) {
                const j = await r.json().catch(() => ({}));
                return res.json({ ok: true, title: j.title || null, author: j.author_name || null, provider: 'youtube' });
            }
        }

        const r = await fetch(url, { redirect: 'follow', timeout: 15000 });
        const html = await r.text();

        function pick(re, s) {
            const m = re.exec(s);
            return m ? String(m[1]).trim() : null;
        }

        const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i, html);
        const ogDesc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i, html);
        let title = ogTitle || pick(/<title[^>]*>([^<]+)<\/title>/i, html);
        const desc = ogDesc || pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i, html);

        // Fallback: if title is empty or looks meaningless, use first H1
        function isBadTitleServer(t) {
            const s = String(t || '').trim();
            if (!s) return true;
            const bad = ['home', '首頁', 'index', 'untitled', 'youtube'];
            if (bad.includes(s.toLowerCase())) return true;
            if (s.length < 3) return true;
            return false;
        }
        if (isBadTitleServer(title)) {
            let h1 = pick(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, html);
            if (h1) {
                h1 = h1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (!isBadTitleServer(h1)) title = h1;
            }
        }

        res.json({ ok: true, title: title || null, description: desc || null, provider: 'web' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// SECURE API: Capture link content into a new Markdown note
app.post('/api/link/capture', tgAuth, express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        const preferredTitle = String(req.body?.title || '').trim();
        if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Invalid url' });

        // Fetch HTML
        const r = await fetch(url, { redirect: 'follow', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Portal Clip)' } });
        const html = await r.text();

        function pick(re, s) {
            const m = re.exec(s);
            return m ? String(m[1]).trim() : null;
        }

        // Title
        const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i, html);
        const title = preferredTitle || ogTitle || pick(/<title[^>]*>([^<]+)<\/title>/i, html) || 'Clip';

        // Very lightweight text extraction (no external deps)
        // Preserve rough paragraph/newline structure for Markdown rendering
        let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '\n')
            .replace(/<style[\s\S]*?<\/style>/gi, '\n')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
            .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
            // Line breaks / block boundaries
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/\s*(p|div|section|article|header|footer|h1|h2|h3|h4|h5|h6|li|ul|ol|pre|blockquote|tr)\s*>/gi, '\n')
            .replace(/<\s*(p|div|section|article|header|footer|h1|h2|h3|h4|h5|h6|li|pre|blockquote|tr)\b[^>]*>/gi, '\n')
            // Strip remaining tags
            .replace(/<[^>]+>/g, ' ')
            // Basic entity cleanup
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            // Normalize whitespace but keep newlines
            .replace(/\r/g, '')
            .replace(/[ \t\f\v]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // Keep it bounded
        const MAX_CHARS = 30000;
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '…';

        const lower = (title + ' ' + text + ' ' + url).toLowerCase();

        // Heuristic routing into obsidian_vault
        let folder = 'obsidian_vault/00_Inbox/Clips';
        if (/youtube\.com|youtu\.be/.test(lower)) folder = 'obsidian_vault/收藏/YouTube';
        else if (/arxiv|doi\.|journal|abstract|introduction|methodology|references/.test(lower)) folder = 'obsidian_vault/40_Academic/Clips';
        else if (/stock|equity|portfolio|trading|etf|options|futures|risk|volatility|yield|macro|fed/.test(lower)) folder = 'obsidian_vault/30_Fox_Trading/Clips';

        // Filename
        const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'web'; } })();
        const slugBase = (title || host)
            .toString()
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80)
            .replace(/[^\w\u4e00-\u9fff\- ]+/g, '')
            .trim()
            .replace(/\s+/g, '_');
        const safeSlug = slugBase || host;

        const now = new Date();
        const ymd = now.toISOString().slice(0, 10);
        const dirRel = `${folder}/${ymd}`;
        const dirAbs = path.join(WORKSPACE, dirRel);
        fs.mkdirSync(dirAbs, { recursive: true });

        let fileRel = `${dirRel}/${safeSlug}.md`;
        let fileAbs = path.join(WORKSPACE, fileRel);
        for (let i = 2; fs.existsSync(fileAbs) && i < 200; i++) {
            fileRel = `${dirRel}/${safeSlug}_${i}.md`;
            fileAbs = path.join(WORKSPACE, fileRel);
        }

        const md = [
            `# ${title}`,
            '',
            `Source: ${url}`,
            '',
            '---',
            '',
            text || '(no extractable text)',
            ''
        ].join('\n');

        fs.writeFileSync(fileAbs, md, 'utf8');
        res.json({ ok: true, path: fileRel });
    } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// SECURE API: Nano Banana (Gemini image) generate/edit
app.post('/api/nano-banana/generate', tgAuth, express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY || '';
        if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing GEMINI_API_KEY' });

        const prompt = String(req.body?.prompt || '').trim();
        const aspectRatio = String(req.body?.aspectRatio || '1:1').trim();
        if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt' });

        const modelId = 'gemini-2.5-flash-image';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseModalities: ['IMAGE'],
                imageConfig: { aspectRatio }
            }
        };

        const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ ok: false, error: j?.error?.message || `Gemini HTTP ${r.status}` });

        const parts = j?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p && (p.inlineData || p.inline_data));
        const inline = imgPart?.inlineData || imgPart?.inline_data;
        const b64 = inline?.data;
        const mime = inline?.mimeType || inline?.mime_type || 'image/png';
        if (!b64) return res.status(500).json({ ok: false, error: 'No image returned' });

        const ext = mime.includes('jpeg') ? 'jpg' : (mime.includes('webp') ? 'webp' : 'png');
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10);
        const dirRel = `obsidian_vault/99_Attachments/NanoBanana/${ymd}`;
        const dirAbs = path.join(WORKSPACE, dirRel);
        fs.mkdirSync(dirAbs, { recursive: true });

        const safe = prompt.slice(0, 60).replace(/\s+/g, ' ').replace(/[^\w\u4e00-\u9fff\- ]+/g, '').trim().replace(/\s+/g, '_') || 'image';
        let fileRel = `${dirRel}/${safe}.${ext}`;
        let fileAbs = path.join(WORKSPACE, fileRel);
        for (let i = 2; fs.existsSync(fileAbs) && i < 200; i++) {
            fileRel = `${dirRel}/${safe}_${i}.${ext}`;
            fileAbs = path.join(WORKSPACE, fileRel);
        }

        fs.writeFileSync(fileAbs, Buffer.from(b64, 'base64'));
        res.json({ ok: true, path: fileRel, mime });
    } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

app.post('/api/nano-banana/edit', tgAuth, express.json({ limit: '8mb' }), async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY || '';
        if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing GEMINI_API_KEY' });

        const prompt = String(req.body?.prompt || '').trim();
        const imageB64 = String(req.body?.imageBase64 || '').trim();
        const imageMime = String(req.body?.imageMime || 'image/png').trim();
        const aspectRatio = String(req.body?.aspectRatio || '1:1').trim();
        if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt' });
        if (!imageB64) return res.status(400).json({ ok: false, error: 'Missing imageBase64' });

        const modelId = 'gemini-2.5-flash-image';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const body = {
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType: imageMime, data: imageB64 } }
                ]
            }],
            generationConfig: {
                responseModalities: ['IMAGE'],
                imageConfig: { aspectRatio }
            }
        };

        const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ ok: false, error: j?.error?.message || `Gemini HTTP ${r.status}` });

        const parts = j?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p && (p.inlineData || p.inline_data));
        const inline = imgPart?.inlineData || imgPart?.inline_data;
        const b64 = inline?.data;
        const mime = inline?.mimeType || inline?.mime_type || 'image/png';
        if (!b64) return res.status(500).json({ ok: false, error: 'No image returned' });

        const ext = mime.includes('jpeg') ? 'jpg' : (mime.includes('webp') ? 'webp' : 'png');
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10);
        const dirRel = `obsidian_vault/99_Attachments/NanoBanana/${ymd}`;
        const dirAbs = path.join(WORKSPACE, dirRel);
        fs.mkdirSync(dirAbs, { recursive: true });

        const safe = 'edit_' + now.toISOString().replace(/[:.]/g, '-');
        const fileRel = `${dirRel}/${safe}.${ext}`;
        const fileAbs = path.join(WORKSPACE, fileRel);

        fs.writeFileSync(fileAbs, Buffer.from(b64, 'base64'));
        res.json({ ok: true, path: fileRel, mime });
    } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

app.get('/api/memory-search', tgAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').toString().trim();
        if (!q) return res.json({ query: q, results: [] });
        if (q.length > 200) return res.status(400).json({ error: 'Query too long' });

        const scriptPath = path.join(WORKSPACE, 'scripts', 'hybrid_memory_search.py');
        const { execFile } = await import('child_process');

        execFile(
            'python3',
            [scriptPath, q, '--top-k', '12', '--mode', 'notes', '--vault-mode', 'on', '--include-workspace', 'on'],
            { timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    return res.status(500).json({ error: err.message, stderr: (stderr || '').slice(0, 2000) });
                }
                try {
                    const data = JSON.parse(stdout);
                    return res.json(data);
                } catch (e) {
                    return res.status(500).json({ error: 'Bad JSON from search script', raw: (stdout || '').slice(0, 2000) });
                }
            }
        );
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/workspace/raw', requireAuth, (req, res) => {
    const reqPath = req.query.path || '';
    const targetPath = path.normalize(path.join(WORKSPACE, String(reqPath)));
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).json({ error: 'Access denied' });

    // If user opens the raw PDF URL directly in a browser tab, many browsers still show the URL segment
    // ("raw") as the tab title. Redirect to /pdf wrapper (HTML) so we can set a proper title.
    if (targetPath.toLowerCase().endsWith('.pdf')) {
        const accept = String(req.headers['accept'] || '');
        // If user opens raw PDF directly in a browser tab (HTML accept), redirect to /pdf wrapper.
        // BUT: when /pdf wrapper embeds the raw PDF in an iframe, it passes embed=1; do NOT redirect,
        // otherwise the iframe will recursively load /pdf and never render the PDF bytes.
        if (accept.includes('text/html') && String(req.query.embed || '') !== '1') {
            const qs = new URLSearchParams(req.query);
            return res.redirect(302, `/pdf?${qs.toString()}`);
        }

        // Ensure file exists before setting PDF headers to avoid leaking PDF headers on 404
        if (!fs.existsSync(targetPath)) {
            return res.status(404).send('Not found');
        }

        // Force correct PDF headers for native viewer (Telegram WebView otherwise may render as text or hang)
        res.setHeader('Content-Type', 'application/pdf');
        const filename = path.basename(targetPath);
        const filenameStar = encodeURIComponent(filename);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filenameStar}`);
        res.setHeader('Cache-Control', 'no-store');
    }

    res.sendFile(targetPath);
});

// Raw file via session auth (no TG initData header needed) — best for native PDF viewer in iframes.
function localOnly(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
    // Allow localhost only (IPv4/IPv6). This is used for internal smoke tests.
    if (ip.includes('127.0.0.1') || ip.includes('::1')) return next();
    return res.status(403).send('Forbidden');
}

function sendRawFile(req, res) {
    const reqPath = String(req.query.path || '');
    if (!reqPath) return res.status(400).send('Missing path');
    const targetPath = path.normalize(path.join(WORKSPACE, reqPath));
    if (!targetPath.startsWith(WORKSPACE)) return res.status(403).send('Access denied');

    res.setHeader('Cache-Control', 'no-store');

    // Force correct MIME for native PDF viewer (some WebViews otherwise render as text)
    if (targetPath.toLowerCase().endsWith('.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
        // Provide filename so browser PDF viewer tab title shows the real file name (not "raw")
        const filename = path.basename(targetPath);
        const filenameStar = encodeURIComponent(filename);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filenameStar}`);
    }

    return res.sendFile(targetPath);
}

// PDF wrapper: sets proper tab title + header, embeds the real PDF via iframe
app.get('/pdf', requireAuth, (req, res) => {
    try {
        const reqPath = String(req.query.path || '');
        if (!reqPath) return res.status(400).send('Missing path');
        const filename = path.basename(reqPath);

        // Keep auth context the same as caller (token/initData) so iframe can load.
        const qs = new URLSearchParams();
        qs.set('path', reqPath);
        if (req.query.token) qs.set('token', String(req.query.token));
        if (req.query.initData) qs.set('initData', String(req.query.initData));

        // Use raw endpoint inside iframe (set embed=1 to prevent raw endpoint redirecting back to /pdf)
        qs.set('embed', '1');
        const iframeSrc = `/api/workspace/raw?${qs.toString()}`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${filename.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>
  <style>
    body{margin:0;background:#0b0f14;color:#e6edf3;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
    .bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(11,15,20,.92);border-bottom:1px solid rgba(255,255,255,.08)}
    .name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    iframe{width:100%;height:calc(100vh - 48px);border:0;background:#111;}
  </style>
</head>
<body>
  <div class="bar"><div class="name">${filename.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div></div>
  <iframe id="pdfFrame" src="${iframeSrc}"></iframe>
  <script>
    // iOS Chrome/Safari often cannot paginate PDFs inside iframes (shows only page 1).
    // Workaround: on iOS, open the raw PDF directly (still authenticated via query/session).
    (function(){
      const ua = navigator.userAgent || '';
      const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isiOS) {
        window.location.replace('${iframeSrc}');
      }
    })();
  </script>
</body>
</html>`);
    } catch (e) {
        res.status(500).send(String(e?.message || e));
    }
});

app.get('/raw', requireAuth, (req, res) => {
    try {
        return sendRawFile(req, res);
    } catch (e) {
        return res.status(500).send(String(e?.message || e));
    }
});

// Internal raw endpoint for localhost smoke tests (no auth; localhost only)
app.get('/internal/raw', localOnly, (req, res) => {
    try {
        return sendRawFile(req, res);
    } catch (e) {
        return res.status(500).send(String(e?.message || e));
    }
});

// SECURE API: TTS via ElevenLabs directly
app.post('/api/tts', tgAuth, express.json(), async (req, res) => {
    try {
        const text = req.body.text;
        if (!text) return res.status(400).json({ error: 'Missing text' });

        const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || 'sk_e91fda37f2f7c30bd75272f596c91f995d7c78834ad470c7';
        const voiceId = req.body.voiceId || 'pFZP5JQG7iQjIQuC4Bku'; // Lily (multilingual)
        
        const apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVENLABS_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text.substring(0, 5000),
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });

        if (!apiRes.ok) {
            const err = await apiRes.text();
            return res.status(apiRes.status).json({ error: 'ElevenLabs failed', detail: err });
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        const buffer = Buffer.from(await apiRes.arrayBuffer());
        res.send(buffer);
    } catch (e) {
        console.error('[Portal] TTS error:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: Scheduled tasks list
app.get('/api/scheduled-tasks', tgAuth, (req, res) => {
    const tasks = [];
    
    // Read heartbeat state
    let hbState = {};
    try { hbState = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'memory/heartbeat-state.json'), 'utf8')); } catch {}
    
    // Read cron config from openclaw.json
    let cronJobs = [];
    try {
        const config = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
        cronJobs = config.cron || [];
    } catch {}

    // Heartbeat tasks (from HEARTBEAT.md)
    const now = Date.now();
    const lastChecks = hbState.lastChecks || {};
    
    tasks.push({
        icon: '🔧', name: 'Models Restore',
        schedule: '每次啟動時執行',
        status: '自動', statusColor: '#238636'
    });
    tasks.push({
        icon: '🖥️', name: 'Portal 健康檢查',
        schedule: '每 30 分鐘 (Heartbeat)',
        status: '運行中', statusColor: '#238636'
    });
    tasks.push({
        icon: '🌍', name: 'Deep Fox 總經觀察',
        schedule: '每 8 小時',
        status: lastChecks.macro_deduction 
            ? `${Math.round((now - (lastChecks.macro_deduction < 1e12 ? lastChecks.macro_deduction * 1000 : lastChecks.macro_deduction)) / 3600000)}h 前` 
            : '待執行',
        statusColor: lastChecks.macro_deduction && (now - (lastChecks.macro_deduction < 1e12 ? lastChecks.macro_deduction * 1000 : lastChecks.macro_deduction) < 28800000) ? '#238636' : '#d29922'
    });
    tasks.push({
        icon: '🧠', name: 'KG 知識圖譜演化',
        schedule: '每 8 小時 (隨 Deep Fox)',
        status: lastChecks.kg_evolution
            ? `${Math.round((now - (lastChecks.kg_evolution < 1e12 ? lastChecks.kg_evolution * 1000 : lastChecks.kg_evolution)) / 3600000)}h 前`
            : '待執行',
        statusColor: lastChecks.kg_evolution && (now - (lastChecks.kg_evolution < 1e12 ? lastChecks.kg_evolution * 1000 : lastChecks.kg_evolution) < 28800000) ? '#238636' : '#d29922'
    });
    tasks.push({
        icon: '📧', name: '通知 & 事件檢查',
        schedule: '每 3 小時 (Heartbeat)',
        status: '自動', statusColor: '#238636'
    });
    tasks.push({
        icon: '🌙', name: '靜默時段',
        schedule: '00:00–07:00 台北時間',
        status: (() => {
            const tpHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
            const h = parseInt(tpHour);
            return (h >= 0 && h < 7) ? '靜默中' : '活動中';
        })(),
        statusColor: (() => {
            const tpHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
            const h = parseInt(tpHour);
            return (h >= 0 && h < 7) ? '#484f58' : '#238636';
        })()
    });

    // Add cron jobs if any
    cronJobs.forEach(job => {
        tasks.push({
            icon: '⏱️',
            name: job.label || job.task?.substring(0, 40) || 'Cron Job',
            schedule: job.schedule || job.cron || '—',
            status: '排程中', statusColor: '#1f6feb'
        });
    });

    res.json({ tasks, updatedAt: new Date().toISOString() });
});

// API: Upcoming events (default: iCloud CalDAV via secrets/, fallback: Google Calendar)
app.get('/api/calendar/upcoming', tgAuth, async (req, res) => {
    const tz = 'Asia/Taipei';

    // Present in Asia/Taipei for human readability on the home page
    const fmt = (iso) => {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return d.toLocaleString('zh-TW', {
                timeZone: tz,
                weekday: 'short',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }).replace(',', '');
        } catch { return iso; }
    };

    // Minimal iCalendar parsing (good enough for DTSTART/DTEND/SUMMARY/LOCATION)
    const parseIcsEvents = (icsText) => {
        if (!icsText) return [];
        const text = String(icsText)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // unfold lines
            .replace(/\n[ \t]/g, '');

        const blocks = text.split('BEGIN:VEVENT').slice(1);
        const out = [];

        const parseDateValue = (v, tzid) => {
            if (!v) return null;
            // v can be YYYYMMDD or YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
            const mDate = v.match(/^(\d{4})(\d{2})(\d{2})$/);
            if (mDate) {
                const [_, y, mo, d] = mDate;
                // treat as all-day starting at 00:00 UTC; UI will show date anyway
                return new Date(`${y}-${mo}-${d}T00:00:00Z`).toISOString();
            }
            const mDt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
            if (mDt) {
                const [_, y, mo, d, hh, mm, ss, z] = mDt;
                
                // If TZID is Asia/Taipei, this is local time (need to convert to UTC)
                if (tzid && (tzid.includes('Taipei') || tzid.includes('Asia/Taipei'))) {
                    // This is Taiwan local time, convert to UTC by subtracting 8 hours
                    const localISO = `${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`;
                    return new Date(localISO).toISOString();
                }
                
                // If Z is present or no TZID, treat as UTC
                const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z ? 'Z' : 'Z'}`;
                return new Date(iso).toISOString();
            }
            // last resort
            const dt = new Date(v);
            return isNaN(dt) ? null : dt.toISOString();
        };

        const getLineValue = (block, key) => {
            // match KEY;PARAM=...:VALUE or KEY:VALUE
            const re = new RegExp(`^${key}(?:;[^:\n]+)*:(.*)$`, 'mi');
            const m = block.match(re);
            return m ? String(m[1]).trim() : '';
        };
        
        const getLineWithTZID = (block, key) => {
            // Extract TZID parameter if present
            const re = new RegExp(`^${key}(?:;([^:]+))?:(.*)$`, 'mi');
            const m = block.match(re);
            if (!m) return { value: '', tzid: null };
            
            const params = m[1] || '';
            const value = (m[2] || '').trim();
            
            // Extract TZID from params
            const tzidMatch = params.match(/TZID=([^;]+)/i);
            const tzid = tzidMatch ? tzidMatch[1] : null;
            
            return { value, tzid };
        };

        for (const raw of blocks) {
            const block = raw.split('END:VEVENT')[0] || '';
            const summary = getLineValue(block, 'SUMMARY') || '(無標題)';
            const location = getLineValue(block, 'LOCATION') || '';
            const uid = getLineValue(block, 'UID') || '';
            const rrule = getLineValue(block, 'RRULE') || '';

            const dtStart = getLineWithTZID(block, 'DTSTART');
            const dtEnd = getLineWithTZID(block, 'DTEND');

            const start = parseDateValue(dtStart.value, dtStart.tzid);
            const end = parseDateValue(dtEnd.value, dtEnd.tzid);
            const allDay = /^\d{8}$/.test(dtStart.value);

            out.push({ uid, summary, location: location || null, start, end, allDay, rrule });
        }

        return out;
    };

    const basicAuth = (user, pw) => {
        const token = Buffer.from(`${user}:${pw}`, 'utf8').toString('base64');
        return `Basic ${token}`;
    };

    const readSecret = (p) => {
        try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
    };

    const getIcloudUpcoming = async (days) => {
        // Prefer env vars (cloud-native), fall back to workspace secret files
        const user = (process.env.ICLOUD_USERNAME || '').trim()
            || readSecret(path.join(WORKSPACE, 'secrets', 'icloud_username.txt'));
        const pw = (process.env.ICLOUD_APP_PASSWORD || '').trim()
            || readSecret(path.join(WORKSPACE, 'secrets', 'icloud_app_password.txt'));
        if (!user || !pw) throw new Error('Missing iCloud credentials (set ICLOUD_USERNAME + ICLOUD_APP_PASSWORD env vars)');

        const auth = basicAuth(user, pw);
        const xmlParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            removeNSPrefix: true,
        });

        // Manually follow redirects to preserve Authorization header.
        // Node.js fetch (undici) strips Authorization on cross-origin redirects,
        // which breaks iCloud CalDAV (caldav.icloud.com → p##-caldav.icloud.com).
        const caldavFetch = async (url, { method = 'PROPFIND', depth = '0', body = '' } = {}) => {
            const headers = {
                Authorization: auth,
                Depth: depth,
                // iCloud prefers text/xml; application/xml may be rejected
                'Content-Type': 'text/xml; charset=utf-8',
                // Some CalDAV servers (including iCloud) require a User-Agent
                'User-Agent': 'Portal/1.0 (caldav)',
            };
            let currentUrl = url;
            for (let redirects = 0; redirects < 6; redirects++) {
                const r = await fetch(currentUrl, {
                    method,
                    headers,
                    body: body || undefined,
                    redirect: 'manual',
                });
                if (r.status >= 300 && r.status < 400) {
                    const loc = r.headers.get('location');
                    if (!loc) throw new Error(`CalDAV redirect with no Location header (${r.status})`);
                    currentUrl = new URL(loc, currentUrl).toString();
                    continue;
                }
                const text = await r.text();
                if (!r.ok) {
                    const wwwAuth = r.headers.get('www-authenticate') || '';
                    const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
                    throw new Error(`CalDAV ${method} ${r.status} @ ${currentUrl} | WWW-Auth: ${wwwAuth} | ${snippet}`);
                }
                return text;
            }
            throw new Error('Too many CalDAV redirects');
        };

        // 1) discover principal
        const discoverXml = await caldavFetch('https://caldav.icloud.com/', {
            method: 'PROPFIND',
            depth: '0',
            body: `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal />
  </D:prop>
</D:propfind>`,
        });

        const discover = xmlParser.parse(discoverXml);
        const href1 = (discover?.multistatus?.response?.propstat?.prop?.['current-user-principal']?.href)
            || (Array.isArray(discover?.multistatus?.response)
                ? discover.multistatus.response.find(r => r?.propstat?.prop?.['current-user-principal']?.href)?.propstat?.prop?.['current-user-principal']?.href
                : null);
        if (!href1) throw new Error('Unable to discover iCloud CalDAV principal');
        const principalUrl = new URL(href1, 'https://caldav.icloud.com/').toString();

        // 2) calendar-home-set
        const homeXml = await caldavFetch(principalUrl, {
            method: 'PROPFIND',
            depth: '0',
            body: `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set />
  </D:prop>
</D:propfind>`,
        });
        const home = xmlParser.parse(homeXml);
        const homeHref = (home?.multistatus?.response?.propstat?.prop?.['calendar-home-set']?.href)
            || (Array.isArray(home?.multistatus?.response)
                ? home.multistatus.response.find(r => r?.propstat?.prop?.['calendar-home-set']?.href)?.propstat?.prop?.['calendar-home-set']?.href
                : null);
        if (!homeHref) throw new Error('Unable to discover iCloud calendar-home-set');
        const homeUrl = new URL(homeHref, 'https://caldav.icloud.com/').toString();
        const homeOrigin = new URL(homeUrl).origin;

        // 3) list calendars
        const calsXml = await caldavFetch(homeUrl, {
            method: 'PROPFIND',
            depth: '1',
            body: `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname />
    <D:resourcetype />
  </D:prop>
</D:propfind>`,
        });
        const calsParsed = xmlParser.parse(calsXml);
        const responses = calsParsed?.multistatus?.response;
        const respArr = Array.isArray(responses) ? responses : (responses ? [responses] : []);

        const calendars = respArr
            .map(r => {
                const href = r?.href;
                const display = r?.propstat?.prop?.displayname;
                const types = r?.propstat?.prop?.resourcetype || {};

                // iCloud returns calendars as DAV:collection + (caldav:calendar OR calendarserver:subscribed)
                const isCalendar = Object.prototype.hasOwnProperty.call(types, 'calendar')
                    || Object.prototype.hasOwnProperty.call(types, 'subscribed');

                if (!href || !isCalendar) return null;

                // Exclude schedule inbox/outbox/notification collections
                if (String(href).includes('/inbox/') || String(href).includes('/outbox/') || String(href).includes('/notification/')) return null;

                return {
                    url: new URL(href, homeOrigin).toString(),
                    name: (Array.isArray(display) ? display[0] : display) || 'Calendar',
                };
            })
            .filter(Boolean);

        const now = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

        const minMs = Date.parse(timeMin);
        const maxMs = Date.parse(timeMax);

        // Very small RRULE support (WEEKLY only) to show the next occurrence inside the window.
        // iCloud CalDAV may return master recurring events; DTSTART may be earlier than the queried window.
        const weekdayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
        const pickNextWeeklyOccurrence = (dtStartIso, rrule) => {
            if (!dtStartIso || !rrule) return null;
            const parts = Object.fromEntries(String(rrule).split(';').map(kv => {
                const [k, v] = kv.split('=');
                return [String(k || '').toUpperCase(), String(v || '')];
            }));
            if ((parts.FREQ || '').toUpperCase() !== 'WEEKLY') return null;

            const byday = (parts.BYDAY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            const allowed = new Set(byday.map(d => weekdayMap[d]).filter(v => v !== undefined));

            const dt0 = new Date(dtStartIso);
            if (isNaN(dt0)) return null;
            const hh = dt0.getUTCHours(), mm = dt0.getUTCMinutes(), ss = dt0.getUTCSeconds();

            const startDay = new Date(minMs);
            startDay.setUTCHours(0, 0, 0, 0);
            const daysSpan = Math.ceil((maxMs - startDay.getTime()) / (24 * 60 * 60 * 1000));

            for (let i = 0; i <= daysSpan; i++) {
                const d = new Date(startDay.getTime() + i * 24 * 60 * 60 * 1000);
                const wd = d.getUTCDay();
                const ok = allowed.size ? allowed.has(wd) : (wd === dt0.getUTCDay());
                if (!ok) continue;
                d.setUTCHours(hh, mm, ss, 0);
                const t = d.getTime();
                if (t >= minMs && t <= maxMs && t >= dt0.getTime()) return d.toISOString();
            }
            return null;
        };

        // 4) query each calendar
        const allItems = [];
        const timeMinStr = timeMin.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const timeMaxStr = timeMax.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

        for (const cal of calendars) {
            const reportXml = await caldavFetch(cal.url, {
                method: 'REPORT',
                depth: '1',
                body: `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag />
    <C:calendar-data>
      <C:expand start="${timeMinStr}" end="${timeMaxStr}" />
    </C:calendar-data>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${timeMinStr}" end="${timeMaxStr}" />
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
            });

            const rep = xmlParser.parse(reportXml);
            const repResponses = rep?.multistatus?.response;
            const repArr = Array.isArray(repResponses) ? repResponses : (repResponses ? [repResponses] : []);

            for (const r of repArr) {
                const ics = r?.propstat?.prop?.['calendar-data'];
                if (!ics) continue;
                const evs = parseIcsEvents(ics);
                for (const ev of evs) {
                    let start = ev.start;
                    let end = ev.end;

                    // If this is a weekly recurring master event, show the next occurrence within [timeMin, timeMax].
                    const startMs0 = Date.parse(start || '');
                    if (ev.rrule && Number.isFinite(startMs0) && startMs0 < minMs) {
                        const nextStart = pickNextWeeklyOccurrence(start, ev.rrule);
                        if (nextStart) {
                            // Preserve duration if DTEND exists
                            const endMs0 = Date.parse(end || '');
                            if (Number.isFinite(endMs0) && endMs0 > startMs0) {
                                const dur = endMs0 - startMs0;
                                start = nextStart;
                                end = new Date(Date.parse(nextStart) + dur).toISOString();
                            } else {
                                start = nextStart;
                            }
                        }
                    }

                    allItems.push({
                        id: ev.uid || crypto.createHash('md5').update(String(ics)).digest('hex'),
                        summary: ev.summary,
                        location: ev.location,
                        allDay: !!ev.allDay,
                        start,
                        end,
                        startLocal: ev.allDay ? (start ? start.slice(0, 10) : '') : fmt(start),
                        calendar: cal.name,
                    });
                }
            }
        }

        // Server-side safety filter (some CalDAV servers may ignore time-range filters)
        const filtered = allItems.filter(ev => {
            const t = Date.parse(ev.start || '');
            return Number.isFinite(t) && t >= minMs && t <= maxMs;
        });

        filtered.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
        return { items: filtered.slice(0, 30), timeZone: tz, timeMin, timeMax, source: 'icloud' };
    };

    const getGoogleUpcoming = async (days) => {
        let accessToken = await getGoogleAccessToken();

        const now = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.searchParams.set('timeMin', timeMin);
        url.searchParams.set('timeMax', timeMax);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set('maxResults', '20');

        let apiRes = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        // If token is stale, refresh once and retry
        if (apiRes.status === 401) {
            accessToken = await getGoogleAccessToken({ forceRefresh: true });
            apiRes = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        }

        const data = await apiRes.json();
        if (!apiRes.ok) {
            const detail = data;
            const msg = (detail?.error?.message || '').toLowerCase().includes('invalid_grant')
                ? 'Google OAuth required'
                : 'Google Calendar API failed';
            const err = new Error(msg);
            err.detail = detail;
            err.status = apiRes.status;
            throw err;
        }

        const items = (data.items || []).map(ev => {
            const startIso = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00Z` : '');
            const endIso = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00Z` : '');
            const allDay = !!ev.start?.date && !ev.start?.dateTime;
            return {
                id: ev.id,
                summary: ev.summary,
                location: ev.location,
                allDay,
                start: startIso,
                end: endIso,
                startLocal: allDay ? (ev.start?.date || '') : fmt(startIso),
            };
        });

        return { items, timeZone: tz, timeMin, timeMax, source: 'google' };
    };

    try {
        const days = Math.max(1, Math.min(14, parseInt(String(req.query.days || '3'), 10) || 3));

        // Determine calendar provider:
        //   CALENDAR_PROVIDER=icloud → always use iCloud
        //   CALENDAR_PROVIDER=google → always use Google
        //   (unset) → use iCloud if credentials available, else Google
        const provider = (process.env.CALENDAR_PROVIDER || '').toLowerCase();
        const hasIcloudCreds = (process.env.ICLOUD_USERNAME && process.env.ICLOUD_APP_PASSWORD)
            || (fs.existsSync(path.join(WORKSPACE, 'secrets', 'icloud_username.txt'))
                && fs.existsSync(path.join(WORKSPACE, 'secrets', 'icloud_app_password.txt')));

        const useIcloud = provider === 'icloud' || (provider !== 'google' && hasIcloudCreds);
        const payload = useIcloud
            ? await getIcloudUpcoming(days)
            : await getGoogleUpcoming(days);

        res.json(payload);
    } catch (e) {
        const status = e?.status || 500;
        res.status(status).json({ error: e.message, detail: e.detail, source: e.source });
    }
});

// SECURE API: Track file access in daily notes
app.post('/api/workspace/track-access', tgAuth, express.json(), (req, res) => {
    try {
        const filePath = req.body.path;
        if (!filePath) return res.status(400).json({ error: 'Missing path' });

        const now = new Date();
        const taipeiOffset = 8 * 60 * 60 * 1000;
        const taipeiDate = new Date(now.getTime() + taipeiOffset);
        const dateStr = taipeiDate.toISOString().split('T')[0];
        const timeStr = taipeiDate.toISOString().split('T')[1].substring(0, 5);

        const memDir = path.join(WORKSPACE, 'memory');
        if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

        const dailyFile = path.join(memDir, `${dateStr}.md`);
        const entry = `- \`${timeStr}\` 📖 ${filePath}`;
        const sectionHeader = '\n### 📖 檔案存取記錄\n';

        if (fs.existsSync(dailyFile)) {
            let content = fs.readFileSync(dailyFile, 'utf-8');
            if (content.includes('### 📖 檔案存取記錄')) {
                // Check for duplicate (same file within last entries)
                const lines = content.split('\n');
                const lastEntries = lines.slice(-5).join('\n');
                if (lastEntries.includes(filePath)) {
                    return res.json({ ok: true, skipped: true });
                }
                content += '\n' + entry;
            } else {
                content += sectionHeader + entry;
            }
            fs.writeFileSync(dailyFile, content);
        } else {
            fs.writeFileSync(dailyFile, `# ${dateStr} Daily Log\n${sectionHeader}${entry}\n`);
        }

        res.json({ ok: true, date: dateStr, file: filePath });
    } catch (e) {
        console.error('[Portal] Track access error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Upload API ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

function classifyFile(filename) {
    const lower = filename.toLowerCase();
    const ext = path.extname(filename).toLowerCase();
    
    // Academic papers (PDF with keywords)
    if (ext === '.pdf' && /module|paper|journal|research|study|analysis/i.test(filename)) {
        return 'obsidian_vault/40_Academic';
    }
    
    // Trading/Strategy
    if (/strategy|backtest|trade|stock|market|alpha|signal|portfolio/i.test(filename)) {
        return 'obsidian_vault/30_Fox_Trading';
    }
    
    // Medical device
    if (/sage|biomed|medical|device|fda|clinical/i.test(filename)) {
        return 'obsidian_vault/20_Sage4_Biomed';
    }
    
    // Academic (other)
    if (/homework|assignment|課|作業|報告|exam|test/i.test(filename)) {
        return 'obsidian_vault/40_Academic';
    }
    
    // System/config files
    if (ext === '.json' || ext === '.yaml' || ext === '.toml' || ext === '.env') {
        return 'obsidian_vault/80_System';
    }
    
    // Images/attachments
    if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.pdf', '.zip'].includes(ext)) {
        return 'obsidian_vault/99_Attachments';
    }
    
    // Default: inbox
    return 'obsidian_vault/00_Inbox';
}

// More precise destination suggestions (post-upload review step)
function suggestPreciseDestination(filename) {
    const name = String(filename || '');
    const lower = name.toLowerCase();

    // Derivatives / Options / Stochastic calculus
    if (/衍生性|期貨|選擇權|伊藤|ito|brownian|布朗|hull|black[-\s]?scholes|bsm/i.test(name)) {
        return 'obsidian_vault/40_Academic/Options_Futures_Derivatives';
    }

    // Portfolio / factor / fund performance
    if (/投資組合|效率前緣|基金|績效|fama|french|carhart|mutual|portfolio|factor|alpha/i.test(name)) {
        return 'obsidian_vault/40_Academic/Stock_Investment_Portfolio_Management';
    }

    // FinTech / investment
    if (/金融科技|fintech/i.test(name)) {
        return 'obsidian_vault/40_Academic/Stock_Investment_Portfolio_Management';
    }

    return null;
}

function _scoreFilename(s) {
    if (!s) return -1e9;
    const rep = (s.match(/\ufffd/g) || []).length; // replacement char
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const mojibake = (s.match(/[ÃÂ]/g) || []).length;
    return cjk * 3 - rep * 10 - mojibake * 2 - s.length * 0.01;
}

function normalizeFilename(original) {
    const a = String(original || '');
    let b = a;
    try { b = Buffer.from(a, 'latin1').toString('utf8'); } catch { b = a; }

    // Pick the better-scoring candidate
    const sa = _scoreFilename(a);
    const sb = _scoreFilename(b);
    return sb > sa ? b : a;
}

app.post('/api/upload', tgAuth, upload.array('files', 20), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ ok: false, error: 'No files uploaded' });
        }
        
        const summary = {};
        const uploaded = [];
        const review = [];
        
        for (const file of req.files) {
            // Decode filename (Telegram/Discord may deliver latin1-ish mojibake)
            let filename = normalizeFilename(file.originalname);
            
            const targetDir = classifyFile(filename);
            const fullDir = path.join(WORKSPACE, targetDir);
            
            // Create directory if not exists
            if (!fs.existsSync(fullDir)) {
                fs.mkdirSync(fullDir, { recursive: true });
            }
            
            // Write file with proper encoding
            const targetPath = path.join(fullDir, filename);
            fs.writeFileSync(targetPath, file.buffer);
            
            // Add to summary
            if (!summary[targetDir]) summary[targetDir] = [];
            summary[targetDir].push(filename);
            uploaded.push(targetPath);

            const relPath = path.posix.join(targetDir.replace(/\\/g, '/'), filename);
            const suggestedDir = suggestPreciseDestination(filename) || null;
            review.push({
                filename,
                currentDir: targetDir,
                path: relPath,
                suggestedDir,
            });
        }
        
        // Log to daily notes
        const now = new Date();
        const taipeiOffset = 8 * 60 * 60 * 1000;
        const taipeiDate = new Date(now.getTime() + taipeiOffset);
        const dateStr = taipeiDate.toISOString().split('T')[0];
        const timeStr = taipeiDate.toISOString().split('T')[1].substring(0, 5);
        
        const memDir = path.join(WORKSPACE, 'memory');
        if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
        
        const dailyFile = path.join(memDir, `${dateStr}.md`);
        const entry = `- \`${timeStr}\` 📤 上傳 ${req.files.length} 個檔案`;
        const sectionHeader = '\n### 📤 檔案上傳記錄\n';
        
        if (fs.existsSync(dailyFile)) {
            let content = fs.readFileSync(dailyFile, 'utf-8');
            if (content.includes('### 📤 檔案上傳記錄')) {
                content += '\n' + entry;
            } else {
                content += sectionHeader + entry;
            }
            fs.writeFileSync(dailyFile, content);
        } else {
            fs.writeFileSync(dailyFile, `# ${dateStr} Daily Log\n${sectionHeader}${entry}\n`);
        }
        
        res.json({ ok: true, summary, count: uploaded.length, review });
    } catch (e) {
        console.error('[Portal] Upload error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Relocate uploaded files (post-upload review)
app.post('/api/upload/relocate', tgAuth, express.json({ limit: '2mb' }), (req, res) => {
    try {
        const moves = req.body?.moves;
        if (!Array.isArray(moves) || moves.length === 0) {
            return res.status(400).json({ ok: false, error: 'Missing moves[]' });
        }

        const results = [];

        for (const m of moves) {
            const from = String(m?.from || '');
            const toDir = String(m?.toDir || '');
            if (!from || !toDir) continue;

            // Security: workspace relative only
            const absFrom = path.join(WORKSPACE, from);
            const absToDir = path.join(WORKSPACE, toDir);
            if (!absFrom.startsWith(WORKSPACE) || !absToDir.startsWith(WORKSPACE)) continue;

            if (!fs.existsSync(absFrom)) {
                results.push({ from, ok: false, error: 'missing' });
                continue;
            }

            fs.mkdirSync(absToDir, { recursive: true });
            const filename = path.basename(absFrom);
            const absTo = path.join(absToDir, filename);
            fs.renameSync(absFrom, absTo);
            results.push({ from, to: path.posix.join(toDir.replace(/\\/g, '/'), filename), ok: true });
        }

        res.json({ ok: true, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- Voice Command API (transcribe -> agent -> TTS) ---
app.post('/api/voice-command', tgAuth, upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ ok: false, error: 'No audio file' });
        }

        // Step 1: Transcribe audio to text - use native FormData
        const formData = new FormData();
        
        // Create a Blob from the buffer
        const audioBlob = new Blob([req.file.buffer], { type: 'audio/wav' });
        formData.append('audio', audioBlob, 'voice_command.wav');
        formData.append('language', 'auto');

        const base = VOICE_SERVER_URL.endsWith('/') ? VOICE_SERVER_URL.slice(0, -1) : VOICE_SERVER_URL;
        
        // Log for debugging
        console.log('[Voice] Sending audio, size:', req.file.buffer.length);
        
        const transcribeCtl = new AbortController();
        const transcribeTimer = setTimeout(() => transcribeCtl.abort(), 60_000);

        let transcript = '';

        // Try voice-server first; if it's down, fallback to OpenAI Whisper API.
        try {
            const transcribeRes = await fetch(`${base}/v1/transcribe`, {
                method: 'POST',
                headers: {
                    'X-Portal-Token': VOICE_SERVER_TOKEN
                },
                body: formData,
                signal: transcribeCtl.signal
            }).finally(() => clearTimeout(transcribeTimer));

            if (!transcribeRes.ok) {
                const errorText = await transcribeRes.text().catch(() => 'No error body');
                console.error('[Portal] Transcribe failed:', transcribeRes.status, errorText);
                throw new Error(`voice-server transcribe failed: ${transcribeRes.status} - ${errorText}`);
            }

            const transcribeData = await transcribeRes.json();
            transcript = transcribeData.text || '';
        } catch (e) {
            console.warn('[Voice] voice-server transcribe unavailable, falling back to OpenAI:', e?.message || e);

            const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
            if (!OPENAI_KEY) throw new Error('Transcribe failed: voice-server unavailable and OPENAI_API_KEY missing');

            const openaiFd = new FormData();
            openaiFd.append('file', audioBlob, 'voice_command.wav');
            openaiFd.append('model', 'whisper-1');

            const r2 = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
                body: openaiFd,
            });
            const j2 = await r2.json().catch(() => ({}));
            if (!r2.ok) {
                throw new Error(`OpenAI transcribe failed: ${j2?.error?.message || r2.status}`);
            }
            transcript = j2.text || '';
        }

        if (!transcript.trim()) {
            return res.json({ ok: false, error: 'No speech detected' });
        }

        console.log('[Voice] Transcript:', transcript);

        // Step 2: Agent reply
        // 1) Fast shortcut: weather (prevents CLI/plugin noise from polluting responses)
        // 2) Fallback: OpenClaw CLI (best effort)

        let agentReply = '';

        // --- Shortcut: Weather (台北預設) ---
        try {
            const t = transcript.trim();
            const wantsWeather = /天氣|氣溫|溫度|下雨|降雨|雨勢|雷雨|晴|陰|颱風|風速/i.test(t);
            if (wantsWeather) {
                const loc = /台北|臺北/i.test(t) ? 'Taipei' : 'Taipei';
                const wRes = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
                    headers: { 'User-Agent': 'portal-voice/1.0' }
                });
                if (wRes.ok) {
                    const w = await wRes.json();
                    const days = w?.weather || [];
                    const tomorrow = days[1] || days[0];
                    if (tomorrow) {
                        const maxC = tomorrow.maxtempC;
                        const minC = tomorrow.mintempC;
                        const sunH = tomorrow.sunHour;
                        const chanceRain = Math.max(...(tomorrow.hourly || []).map(h => Number(h.chanceofrain || 0)).filter(n => Number.isFinite(n)), 0);
                        agentReply = `台北明天天氣：${minC}–${maxC}°C，降雨機率最高約 ${chanceRain}%，日照約 ${sunH} 小時。`;
                    }
                }
            }
        } catch (e) {
            console.warn('[Voice] Weather shortcut failed:', e?.message || e);
        }

        // --- Fallback: OpenClaw CLI ---
        if (!agentReply) {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);

            const escapedText = transcript.replace(/'/g, "'\\''");
            // IMPORTANT: do NOT merge stderr into stdout (avoid 'Cannot find module...' leaking to users)
            const cmd = `cd ${WORKSPACE} && timeout 30 openclaw agent --agent main -m '${escapedText}' --thinking minimal --timeout 25 --no-color`;

            try {
                const { stdout } = await execAsync(cmd, {
                    maxBuffer: 1024 * 1024,
                    timeout: 35000
                });

                // Best effort: CLI sometimes prints a transcript; keep the last few meaningful lines
                const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                agentReply = lines.slice(-12).join('\n');

                if (!agentReply) agentReply = '收到，但目前沒有拿到 Agent 的文字回覆（API 正在修復中）。';
            } catch (err) {
                console.error('[Voice] Agent call failed:', err?.message || err);
                agentReply = '目前語音指令的 Agent API 仍在修復中；我可以先回答天氣等簡單查詢。';
            }
        }

        console.log('[Voice] Agent reply bytes:', Buffer.byteLength(agentReply || '', 'utf8'));

        // Step 3: Convert reply to TTS - send as JSON
        // Step 3: Convert reply to TTS - keep it short to avoid slow TTS generation
        const MAX_TTS_CHARS = 420;
        const ttsTextRaw = (agentReply || '').trim();
        const ttsText = ttsTextRaw.length > MAX_TTS_CHARS ? (ttsTextRaw.slice(0, MAX_TTS_CHARS) + '...（略）') : ttsTextRaw;

        console.log('[Voice] TTS request chars:', ttsText.length);

        const ttsCtl = new AbortController();
        const ttsTimer = setTimeout(() => ttsCtl.abort(), 60_000);

        let audioBuffer;

        // Try voice-server TTS first; if it's down, fallback to OpenAI TTS.
        try {
            const ttsRes = await fetch(`${base}/v1/tts`, {
                method: 'POST',
                headers: {
                    'X-Portal-Token': VOICE_SERVER_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: ttsText,
                    // Let voice-server pick its configured default voice_id
                    language: 'zh'
                }),
                signal: ttsCtl.signal
            }).finally(() => clearTimeout(ttsTimer));

            if (!ttsRes.ok) {
                const errorText = await ttsRes.text().catch(() => 'No error body');
                console.error('[Portal] TTS failed:', ttsRes.status, errorText);
                throw new Error(`voice-server tts failed: ${ttsRes.status} - ${errorText}`);
            }

            audioBuffer = await ttsRes.arrayBuffer();
        } catch (e) {
            console.warn('[Voice] voice-server TTS unavailable, falling back to OpenAI:', e?.message || e);

            const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
            if (!OPENAI_KEY) throw new Error('TTS failed: voice-server unavailable and OPENAI_API_KEY missing');

            const r2 = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'tts-1',
                    voice: 'alloy',
                    input: ttsText,
                    format: 'mp3'
                })
            });
            if (!r2.ok) {
                const j2 = await r2.json().catch(() => ({}));
                throw new Error(`OpenAI TTS failed: ${j2?.error?.message || r2.status}`);
            }
            audioBuffer = await r2.arrayBuffer();
        }
        console.log('[Voice] TTS audio bytes:', audioBuffer.byteLength);
        const audioFilename = `voice_reply_${Date.now()}.mp3`;
        const audioPath = path.join(WORKSPACE, 'tmp', audioFilename);
        
        // Ensure tmp directory exists
        const tmpDir = path.join(WORKSPACE, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));

        // Return audio URL
        const audioUrl = `/api/workspace/raw?path=tmp/${audioFilename}&token=${STATIC_TOKEN}`;

        res.json({
            ok: true,
            transcript,
            reply: agentReply,
            audioUrl
        });

    } catch (error) {
        console.error('[Portal] Voice command error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// --- Canvas API ---
const CANVAS_STATE_FILE = path.join(WORKSPACE, 'canvas/canvas_state.json');

function loadCanvasState() {
    try { return JSON.parse(fs.readFileSync(CANVAS_STATE_FILE, 'utf-8')); }
    catch { return { type: null, content: null, url: null, hash: null, updatedAt: null }; }
}
function saveCanvasState(state) {
    fs.writeFileSync(CANVAS_STATE_FILE, JSON.stringify(state, null, 2));
}

app.get('/api/canvas/current', tgAuth, (req, res) => {
    res.json(loadCanvasState());
});

app.post('/api/canvas/push', tgAuth, express.json(), (req, res) => {
    const { type, content, url } = req.body;
    if (!type) return res.status(400).json({ error: 'Missing type' });
    const hash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex').slice(0, 12);
    const state = { type, content: content || null, url: url || null, hash, updatedAt: new Date().toISOString() };
    saveCanvasState(state);
    res.json({ ok: true, hash });
});

app.post('/api/canvas/clear', tgAuth, (req, res) => {
    saveCanvasState({ type: null, content: null, url: null, hash: null, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
});

// --- Maps API (server-side proxy; do NOT expose key to browser) ---
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GMAPS_API_KEY || '';

app.get('/api/maps/geocode', tgAuth, async (req, res) => {
    try {
        if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY missing' });
        const q = (req.query.q || '').toString();
        if (!q) return res.status(400).json({ error: 'Missing q' });
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
        const r = await fetch(url);
        const data = await r.json();
        if (!r.ok) return res.status(502).json({ error: 'Geocode upstream error', status: r.status, data });
        const first = (data.results || [])[0];
        if (!first) return res.status(404).json({ error: 'No results' });
        const loc = first.geometry && first.geometry.location;
        return res.json({
            formatted_address: first.formatted_address,
            lat: loc.lat,
            lng: loc.lng,
        });
    } catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});

app.get('/api/maps/static', tgAuth, async (req, res) => {
    try {
        if (!GOOGLE_MAPS_API_KEY) return res.status(500).send('GOOGLE_MAPS_API_KEY missing');
        const lat = (req.query.lat || '').toString();
        const lng = (req.query.lng || '').toString();
        const label = (req.query.label || '📍').toString();
        if (!lat || !lng) return res.status(400).send('Missing lat/lng');
        const center = `${lat},${lng}`;
        const staticUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(center)}&zoom=15&size=720x420&scale=2&maptype=roadmap&markers=color:red%7Clabel:${encodeURIComponent('X')}%7C${encodeURIComponent(center)}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
        const r = await fetch(staticUrl);
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.status(r.status).send(buf);
    } catch (e) {
        return res.status(500).send(String(e));
    }
});

// --- Favorites API ---
const FAVORITES_FILE = path.join(WORKSPACE, 'portal/favorites.json');

function loadFavorites() {
    try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf-8')); } catch { return []; }
}
function saveFavorites(favs) {
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2));
}

app.get('/api/favorites', tgAuth, (req, res) => {
    res.json(loadFavorites());
});

// Favorites page (full list)
app.get('/favorites', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'favorites.html'));
});

// i-chat has been extracted to Service #5 (github.com/tylerwang26/i-chat)


// Favorites details (group by folder, items sorted by created time desc)
app.get('/api/favorites/details', tgAuth, (req, res) => {
    try {
        const favs = loadFavorites();
        const groups = new Map();
        const keepFavs = [];

        for (const f of favs) {
            const rel = f.path;
            if (!rel) continue;
            const folder = path.dirname(rel);
            const abs = path.join(WORKSPACE, rel);
            let st = null;
            try { st = fs.statSync(abs); } catch {}

            // If file is missing, skip it and prune from favorites to keep list in sync.
            if (!st) {
                continue;
            }
            keepFavs.push(f);

            const createdAtMs = st?.birthtimeMs ? Math.floor(st.birthtimeMs) : (st?.mtimeMs ? Math.floor(st.mtimeMs) : null);

            const item = {
                path: rel,
                name: f.name || path.basename(rel),
                folder,
                createdAtMs,
            };

            if (!groups.has(folder)) groups.set(folder, []);
            groups.get(folder).push(item);
        }

        // Persist pruning if any missing favorites were removed
        if (keepFavs.length !== favs.length) {
            try { saveFavorites(keepFavs); } catch {}
        }

        const out = Array.from(groups.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([folder, items]) => ({
                folder,
                items: items.sort((x, y) => (y.createdAtMs || 0) - (x.createdAtMs || 0))
            }));

        res.json({ ok: true, groups: out });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/favorites/toggle', tgAuth, express.json(), (req, res) => {
    const filePath = req.body.path;
    const fileName = req.body.name || filePath?.split('/').pop();
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    let favs = loadFavorites();
    const idx = favs.findIndex(f => f.path === filePath);
    if (idx >= 0) {
        favs.splice(idx, 1);
        saveFavorites(favs);
        return res.json({ favorited: false, favorites: favs });
    }
    favs.unshift({ path: filePath, name: fileName, addedAt: new Date().toISOString() });
    saveFavorites(favs);
    res.json({ favorited: true, favorites: favs });
});

// --- Claude Scientific Skills (K-Dense) ---
const KDENSE_JSON_PATH = path.join(__dirname, 'kdense_skills.json');
const KDENSE_REPO_ROOT = path.join(WORKSPACE, 'tmp/claude-scientific-skills/scientific-skills');
const WORKSPACE_SKILLS_DIR = path.join(WORKSPACE, 'skills');

function loadKdenseIndex() {
    try {
        if (!fs.existsSync(KDENSE_JSON_PATH)) return null;
        return JSON.parse(fs.readFileSync(KDENSE_JSON_PATH, 'utf-8'));
    } catch {
        return null;
    }
}

function safeSkillId(id) {
    if (!id || typeof id !== 'string') return null;
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return null;
    return id;
}

// Public read: allow listing skills without auth (install still requires auth)
app.get('/api/kdense/skills', (req, res) => {
    const index = loadKdenseIndex();
    if (!index) return res.status(404).json({ error: 'kdense_skills.json not found' });

    const skills = (index.skills || []).map(s => {
        const id = s.id;
        const installed = fs.existsSync(path.join(WORKSPACE_SKILLS_DIR, id, 'SKILL.md'));
        return { ...s, installed };
    });

    res.json({ generatedAt: index.generatedAt, skills });
});

app.post('/api/kdense/install', tgAuth, express.json(), (req, res) => {
    try {
        const id = safeSkillId(req.body?.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });

        const index = loadKdenseIndex();
        const existsInIndex = !!(index?.skills || []).find(s => s.id === id);
        if (!existsInIndex) return res.status(404).json({ error: 'Skill not found in index' });

        const src = path.join(KDENSE_REPO_ROOT, id);
        const dst = path.join(WORKSPACE_SKILLS_DIR, id);
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source skill folder missing' });

        fs.mkdirSync(WORKSPACE_SKILLS_DIR, { recursive: true });
        if (!fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true });
        }

        res.json({ ok: true, id, installed: true });
    } catch (e) {
        console.error('[Portal] kdense install error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Healthcheck endpoint (Zeabur/LB friendly)
app.get('/health', (req, res) => res.status(200).type('text/plain').send('ok'));

// Root: return 200 even when unauthenticated (prevents LB marking service unhealthy)
app.get('/', (req, res) => {
    try {
        // If authenticated, serve the home UI; otherwise serve login UI (200).
        if (req.session && req.session.authenticated) {
            return res.sendFile(path.join(__dirname, 'home.html'));
        }
        return res.sendFile(path.join(__dirname, 'login.html'));
    } catch (e) {
        return res.status(200).type('text/plain').send('ok');
    }
});
// Stocks (Vite build) — serves /stocks with assets under /stocks/assets
const STOCKS_DIST_DIR = path.join(__dirname, 'stocks-dist');
app.use('/stocks/assets', requireAuth, express.static(path.join(STOCKS_DIST_DIR, 'assets')));
app.get('/stocks', requireAuth, (req, res) => {
    try {
        const idx = path.join(STOCKS_DIST_DIR, 'index.html');
        if (fs.existsSync(idx)) return res.sendFile(idx);
    } catch {}
    // Fallback to the previous no-build React page (safe)
    return res.sendFile(path.join(__dirname, 'stocks-react.html'));
});
app.get('/explorer', (req, res) => {
    // Token auth (same behavior as requireAuth, but return login screen flow)
    const token = req.query.token || req.headers['x-portal-token'];
    if (token === STATIC_TOKEN) {
        if (req.session) { req.session.authenticated = true; req.session.username = 'tyler-token'; }
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(__dirname, 'explorer.html'));
    }

    // Session auth
    if (req.session && req.session.authenticated) {
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(__dirname, 'explorer.html'));
    }

    // Not authenticated: show login, then come back here
    const nextUrl = req.originalUrl || '/explorer';
    return res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
});
app.get('/viewer', requireAuth, (req, res) => {
    const filePath = req.query.path || '';
    if (filePath.toLowerCase().endsWith('.pdf')) {
        const token = req.query.token || '';
        const rawUrl = `/api/workspace/raw?path=${encodeURIComponent(filePath)}${token ? '&token=' + token : ''}`;
        return res.redirect(rawUrl);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'viewer.html'));
});

// Notes editor (opens in a new tab)
app.get('/note', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'note-editor.html'));
});

app.get('/canvas', requireAuth, (req, res) => res.sendFile(path.join(WORKSPACE, 'canvas/index.html')));
app.get('/maps', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'maps.html')));
app.get('/memory-search', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'memory-search.html')));
app.get('/voice', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'voice.html')));
app.get('/voicetalk', requireAuth, (req, res) => res.sendFile('/home/node/voice-server/static/index.html'));

// === Sentiment Risk Radar (formal page + manual update) ===
const SENTIMENT_REPORT_PATH = path.join(WORKSPACE, 'obsidian_vault/30_Fox_Trading/Research/Sentiment_Risk_Radar.md');
const SENTIMENT_CRON_JOB_ID = 'e308f189-5abc-407e-a7d2-1f1aafca08e0';

app.get('/sentiment-radar', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'sentiment-radar.html'));
});

app.get('/api/sentiment-radar/status', tgAuth, (req, res) => {
    try {
        let st = null;
        try { st = fs.statSync(SENTIMENT_REPORT_PATH); } catch {}
        const updatedAtMs = st?.mtimeMs ? Math.floor(st.mtimeMs) : null;
        const updatedAtTaipei = updatedAtMs
            ? new Intl.DateTimeFormat('zh-TW', {
                timeZone: 'Asia/Taipei',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false,
              }).format(new Date(updatedAtMs))
            : null;
        res.json({ ok: true, updatedAtMs, updatedAtTaipei, windowHours: 72 });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/sentiment-radar/run', tgAuth, async (req, res) => {
    try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Fire-and-forget: trigger cron job; the page will poll status by file mtime.
        await execAsync(`openclaw cron run ${SENTIMENT_CRON_JOB_ID} --timeout 30000`, {
            timeout: 35000,
            maxBuffer: 512 * 1024,
        });

        res.json({ ok: true });
    } catch (e) {
        console.error('[SentimentRadar] run failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// Star Office UI proxy — proxy both /office and all Star Office sub-paths
import http from 'http';
function starOfficeProxy(req, res, overridePath) {
    const targetPath = overridePath || req.originalUrl;
    const parsed = new URL(targetPath, 'http://127.0.0.1:19000');
    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 19000,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:19000' },
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).json({ error: 'Star Office UI not running' }));
    req.pipe(proxyReq);
}

// Main office page
app.get('/office', requireAuth, (req, res, next) => starOfficeProxy(req, res, '/'));
app.get('/office/', requireAuth, (req, res, next) => starOfficeProxy(req, res, '/'));

// Star Office static assets & API endpoints (these are absolute paths from the frontend)
const starOfficePaths = [
    '/static', '/status', '/set_state', '/health', '/agents', '/join-agent',
    '/agent-push', '/agent-approve', '/agent-reject', '/leave-agent',
    '/yesterday-memo', '/config/gemini', '/assets', '/join', '/invite'
];
starOfficePaths.forEach(p => {
    app.use(p, requireAuth, (req, res) => starOfficeProxy(req, res));
});

// Bind on IPv6 "::" so checks to http://localhost:<port> (often ::1) don't hang.
// On most Linux setups this also accepts IPv4 via v4-mapped addresses.

// ===== Stocks App Integration =====
app.use('/stocks', express.static(path.join(__dirname, 'stocks-dist')));
app.get('/stocks', (req, res) => res.sendFile(path.join(__dirname, 'stocks-dist', 'index.html')));

// ===== Obsidian Vault Integration =====
app.get('/vault/*', (req, res) => {
    const filePath = path.join(WORKSPACE, 'obsidian_vault', req.params[0]);
    if (!filePath.startsWith(path.join(WORKSPACE, 'obsidian_vault'))) {
        return res.status(403).json({ error: 'Access denied' });
    }
    fs.stat(filePath, (err, stats) => {
        if (err) return res.status(404).json({ error: 'Not found' });
        if (stats.isDirectory()) {
            fs.readdir(filePath, (err, files) => {
                if (err) return res.status(500).json({ error: 'Cannot read directory' });
                res.json({ type: 'directory', files: files });
            });
        } else if (filePath.endsWith('.md')) {
            res.sendFile(filePath);
        } else {
            res.status(400).json({ error: 'Only markdown files are supported' });
        }
    });
});

app.get('/api/vault/structure', (req, res) => {
    const vaultPath = path.join(WORKSPACE, 'obsidian_vault');
    function getStructure(dir, prefix = '') {
        try {
            const files = fs.readdirSync(dir);
            return files.map(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                return { name: file, type: stat.isDirectory() ? 'directory' : 'file', path: prefix ? `${prefix}/${file}` : file };
            });
        } catch (e) { return []; }
    }
    res.json({ structure: getStructure(vaultPath) });
});
app.listen(PORT, '::', () => console.log(`Portal server running on port ${PORT}`));
app.get('/canvas', (req, res) => res.sendFile(path.join(__dirname, 'canvas.html')));
