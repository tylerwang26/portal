import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Block access to sensitive files
app.use((req, res, next) => {
    const blocked = ['/server.js', '/package.json', '/package-lock.json', '/.env', '/.gitignore'];
    if (blocked.some(path => req.path === path) || req.path.startsWith('/node_modules')) {
        return res.status(404).send('Not Found');
    }
    next();
});

app.use(express.static(__dirname));

// Telegram WebApp security
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_TG_USER_ID = Number(process.env.ALLOWED_TG_USER_ID || '549227213');
const TG_INITDATA_MAX_AGE_SEC = Number(process.env.TG_INITDATA_MAX_AGE_SEC || String(24 * 60 * 60));

const WORKSPACE_ROOT = '/home/node/.openclaw/workspace';

// 安全路徑檢查
const getSafePath = (userPath) => {
    const requestedPath = path.join(WORKSPACE_ROOT, userPath || '');
    if (requestedPath.startsWith(WORKSPACE_ROOT)) {
        return requestedPath;
    }
    return WORKSPACE_ROOT;
};

function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') return { ok: false, error: 'missing_initData' };
    if (!BOT_TOKEN) return { ok: false, error: 'missing_bot_token' };

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    if (!hash) return { ok: false, error: 'missing_hash' };

    const entries = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (hmac !== hash) return { ok: false, error: 'bad_hash' };

    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate) return { ok: false, error: 'missing_auth_date' };
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > TG_INITDATA_MAX_AGE_SEC) return { ok: false, error: 'initData_expired', age };

    const userJson = params.get('user');
    let user = null;
    if (userJson) {
        try { user = JSON.parse(userJson); } catch (e) { return { ok: false, error: 'bad_user_json' }; }
    }

    return { ok: true, user, age };
}

function requireTelegramUser(req, res, next) {
    // Accept initData from header or query (header preferred)
    const initData = req.headers['x-tg-initdata'] || req.query.initData;
    const v = verifyTelegramInitData(initData);
    if (!v.ok) return res.status(401).json({ error: 'unauthorized', detail: v.error });

    const userId = Number(v.user && v.user.id);
    if (!userId || userId !== ALLOWED_TG_USER_ID) {
        return res.status(403).json({ error: 'forbidden' });
    }

    req.tgUser = v.user;
    next();
}

// 訊號 API 接口
app.get('/api/signals', requireTelegramUser, (req, res) => {
    const signalsPath = path.join(__dirname, 'signals.json');
    if (fs.existsSync(signalsPath)) {
        const data = fs.readFileSync(signalsPath, 'utf8');
        res.json(JSON.parse(data));
    } else {
        res.json({
            competition: [],
            longterm: []
        });
    }
});

// 檔案清單 API
app.get('/api/workspace/list', requireTelegramUser, (req, res) => {
    const targetPath = getSafePath(req.query.path);
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const list = items.map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            path: path.relative(WORKSPACE_ROOT, path.join(targetPath, item.name))
        }));
        res.json({ currentPath: path.relative(WORKSPACE_ROOT, targetPath), list });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 檔案內容預覽 API
app.get('/api/workspace/view', requireTelegramUser, (req, res) => {
    const targetPath = getSafePath(req.query.path);
    try {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            return res.status(400).json({ error: 'Cannot view directory content' });
        }
        
        // 限制預覽大小 (1MB)
        if (stats.size > 1024 * 1024) {
            return res.status(400).json({ error: 'File too large for preview (>1MB)' });
        }

        const content = fs.readFileSync(targetPath, 'utf8');
        res.json({ name: path.basename(targetPath), content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Catch-all route (Express 5 compatible)
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Little i Portal v5.3 running on port ${PORT}`);
});
