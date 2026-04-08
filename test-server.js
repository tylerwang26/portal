# 自己創建一個 Node.js 應用來兜底測試

const express = require('express');
const path = require('path');
const PORT = process.env.PORT || 8080;

const app = express();

app.use(express.static(path.join(__dirname, '.')));

app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        platform: 'Node.js Test',
        port: PORT,
        message: 'This is a test response. Expect 502 means Zeabur routing issue.',
        time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'PASS',
        app: 'portal-test',
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🦊 Portal Test Server Running on ${PORT}`);
    console.log(`📡 Listening: 0.0.0.0:${PORT}`);
    console.log(`🌐 Health endpoint: /health\n`);
});