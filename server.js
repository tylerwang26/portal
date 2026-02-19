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

// 驗證 API 是否存在
app.get('/api/health', (req, res) => res.send('OK'));

// Webhook
app.post('/api/webhook/update-signals', (req, res) => {
    const { token, data } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (token !== BOT_TOKEN) return res.status(401).send('Unauthorized');
    
    try {
        fs.writeFileSync(path.join(__dirname, 'signals.json'), JSON.stringify(data, null, 2));
        res.send('Updated');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Signals API
app.get('/api/signals', (req, res) => {
    const signalsPath = path.join(__dirname, 'signals.json');
    if (fs.existsSync(signalsPath)) {
        res.json(JSON.parse(fs.readFileSync(signalsPath, 'utf8')));
    } else {
        res.json({ competition: [], longterm: [], updatedAt: new Date().toISOString() });
    }
});

// Workspace List API
app.get('/api/workspace/list', (req, res) => {
    try {
        const items = fs.readdirSync(__dirname, { withFileTypes: true });
        const list = items.filter(item => !item.name.startsWith('.')).map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            path: item.name
        }));
        res.json({ currentPath: '', list });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 靜態檔案放在 API 之後
app.use(express.static(__dirname));

// Catch-all 回傳 index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Portal v5.3.1 running on port ${PORT}`);
});
