import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// 工作目錄判定：Zeabur 環境下，我們將透過 Webhook 或 Git 同步數據
const WORKSPACE_ROOT = __dirname; 

function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') return { ok: false, error: 'missing_initData' };
    if (!BOT_TOKEN) return { ok: true, user: { id: ALLOWED_TG_USER_ID }, debug: 'skipped_verify_no_token' };

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

// 數據更新 Webhook (供 OpenClaw 主控端推送)
app.post('/api/webhook/update-signals', (req, res) => {
    const { token, data } = req.body;
    // 簡單的安全檢查 (建議在環境變數設定 WEBHOOK_TOKEN)
    if (token !== process.env.WEBHOOK_TOKEN && token !== BOT_TOKEN) {
        return res.status(401).send('Unauthorized');
    }
    
    try {
        fs.writeFileSync(path.join(__dirname, 'signals.json'), JSON.stringify(data, null, 2));
        res.send('Updated');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/signals', requireTelegramUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const signalsPath = path.join(__dirname, 'signals.json');
    if (fs.existsSync(signalsPath)) {
        res.json(JSON.parse(fs.readFileSync(signalsPath, 'utf8')));
    } else {
        res.json({ competition: [], longterm: [], updatedAt: new Date().toISOString() });
    }
});

// Explorer API
app.get('/api/workspace/list', requireTelegramUser, (req, res) => {
    const userPath = req.query.path || '';
    const targetPath = path.normalize(path.join(WORKSPACE_ROOT, userPath));
    if (!targetPath.startsWith(WORKSPACE_ROOT)) return res.status(403).send('Forbidden');

    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const list = items
            .filter(item => !item.name.startsWith('.'))
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
    const userPath = req.query.path || '';
    const targetPath = path.normalize(path.join(WORKSPACE_ROOT, userPath));
    if (!targetPath.startsWith(WORKSPACE_ROOT)) return res.status(403).send('Forbidden');

    try {
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
    console.log(`Portal v5.3 running on port ${PORT}`);
});
