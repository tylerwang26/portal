import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 安全限制：禁止存取敏感檔案
app.use((req, res, next) => {
    const blocked = ['/server.js', '/package.json', '/package-lock.json', '/.env', '/.gitignore', '/README.md'];
    const blockedPrefixes = ['/node_modules', '/.git'];
    
    if (blocked.includes(req.path) || blockedPrefixes.some(prefix => req.path.startsWith(prefix))) {
        return res.status(404).send('Not Found');
    }
    next();
});

app.use(express.static(__dirname));

// Telegram WebApp 安全驗證
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_TG_USER_ID = Number(process.env.ALLOWED_TG_USER_ID || '549227213');
const TG_INITDATA_MAX_AGE_SEC = Number(process.env.TG_INITDATA_MAX_AGE_SEC || String(24 * 60 * 60));

// 動態判定工作目錄：若在 Zeabur 則讀取 Repo 根目錄，否則讀取本地 OpenClaw 路徑
const LOCAL_WORKSPACE = '/home/node/.openclaw/workspace';
const WORKSPACE_ROOT = fs.existsSync(LOCAL_WORKSPACE) ? LOCAL_WORKSPACE : __dirname;

const getSafePath = (userPath) => {
    const requestedPath = path.normalize(path.join(WORKSPACE_ROOT, userPath || ''));
    if (requestedPath.startsWith(WORKSPACE_ROOT)) {
        return requestedPath;
    }
    return WORKSPACE_ROOT;
};

function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') return { ok: false, error: 'missing_initData' };
    if (!BOT_TOKEN) return { ok: true, user: { id: ALLOWED_TG_USER_ID }, debug: 'skipped_verify_no_token' }; // 容錯處理

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        if (!hash) return { ok: false, error: 'missing_hash' };

        const entries = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

        const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
        const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (hmac !== hash) return { ok: false, error: 'bad_hash' };

        const userJson = params.get('user');
        const user = userJson ? JSON.parse(userJson) : null;
        return { ok: true, user };
    } catch (e) {
        return { ok: false, error: 'verify_exception' };
    }
}

function requireTelegramUser(req, res, next) {
    const initData = req.headers['x-tg-initdata'] || req.query.initData;
    const v = verifyTelegramInitData(initData);
    
    if (!v.ok) return res.status(401).json({ error: 'unauthorized', detail: v.error });
    if (v.user && Number(v.user.id) !== ALLOWED_TG_USER_ID) return res.status(403).json({ error: 'forbidden' });

    req.tgUser = v.user;
    next();
}

// 訊號 API (強制不快取)
app.get('/api/signals', requireTelegramUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const signalsPath = path.join(__dirname, 'signals.json');
    if (fs.existsSync(signalsPath)) {
        const data = fs.readFileSync(signalsPath, 'utf8');
        res.json(JSON.parse(data));
    } else {
        res.json({ competition: [], longterm: [], updatedAt: new Date().toISOString() });
    }
});

app.get('/api/workspace/list', requireTelegramUser, (req, res) => {
    const targetPath = getSafePath(req.query.path);
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const list = items
            .filter(item => !item.name.startsWith('.')) // 隱藏隱藏檔
            .map(item => ({
                name: item.name,
                isDirectory: item.isDirectory(),
                path: path.relative(WORKSPACE_ROOT, path.join(targetPath, item.name))
            }));
        res.json({ currentPath: path.relative(WORKSPACE_ROOT, targetPath), list });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/view', requireTelegramUser, (req, res) => {
    const targetPath = getSafePath(req.query.path);
    try {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) return res.status(400).json({ error: 'Cannot view directory' });
        if (stats.size > 1024 * 1024) return res.status(400).json({ error: 'File too large' });

        const content = fs.readFileSync(targetPath, 'utf8');
        res.json({ name: path.basename(targetPath), content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Little i Portal v5.3 running on port ${PORT} (Root: ${WORKSPACE_ROOT})`);
});
