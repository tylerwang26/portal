# 🦊 Zeabur PM2 部署方案 - 完整指南

## 📍 文檔位置

**已創建文檔：**
```
/tmp/pm2.config.js                    ← PM2 配置文件
/tmp/PM2_DEPLOY_GUIDE.md              ← 完整部署說明文檔
/home/node/.openclaw/workspace/portal/PM2_DEPLOY_GUIDE.md  ← 複製到這裡
```

---

## 🚀 PM2 部署步驟

### OpenClaw 本地測試 PM2

**先在本地測試 PM2：**
```bash
cd /home/node/.openclaw/workspace/portal

npm install && npm install -g pm2
```

確認本地測試成功後，再讓 Zeabur 使用 PM2。

**本地測試 PM2：**
```bash
pm2 start server.js --name portal-zeabur-test
curl http://localhost:3000/
pm2 stop portal-zeabur-test
```

---

### Zeabur Dashboard 部署 PM2

**Step 1: 環境變數設定**
```
Environment Variables:
  NODE_ENV  → production
  PORT      → 8080
```

**Step 2: Build Command**
```bash
npm install && npm install -g pm2
```

**Step 3: Start Command**
```bash
pm2-runtime start pm2.config.js
```

**Step 4: Deploy → 確認執行**

---

## 📊 PM2 配置說明

```javascript
module.exports = {
  apps: [{
    name: 'portal',
    script: './server.js',
    cwd: '.' + '/workspace/portal',
    instances: 1,
    autorestart: true,        // 服務崩潰自動重啟
    max_memory_restart: '500M', // 超過頂部運算元自動重啟
    env: {
      NODE_ENV: 'production',
      PORT: '8080'
    },
    error_file: '/tmp/pm2-portal-error.log',
    out_file: '/tmp/pm2-portal-out.log'
  }]
}
```

---

## 🧪 部署後驗證

### 1. 查看 Zeabur 日誌
```
應該看到： "Portal server running on port 8080"
```

### 2. 測試 API
```bash
curl "https://portal.zeabur.app/api/calendar/upcoming?days=3&token=T628_TYLER_SAFE_ACCESS"
```

### 3. 測試網頁
```
https://portal.zeabur.app/  
應該看到登入頁面（不是 502）
```

---

## 注意事項

- **本地測試 PM2 成功**：部署到 Zeabur 時，所有重啟機制灑入
- **不要使用 PORT 環境變數設為空或其他端口**：PORT=8080
- **不要使用其他啟動方式**：必須使用 pm2-runtime start

---

*部署完成日期：2026-03-29*

