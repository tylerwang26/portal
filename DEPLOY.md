# Zeabur Portal 部署說明

## ✅ 已完成的修復

### Secrets 配置已恢復
```
✅ icloud_username.txt     → tyler26@gmail.com
✅ icloud_app_password.txt → nuca-uxea-nbtv-odyk
✅ google_oauth_token.json → 已包含 access_token
```

---

## 📦 需要部署到 Zeabur 的文件

### 根目錄（進入 workspace 後上傳）

```bash
/workspace/
├── secrets/              ← 必須！包含 3 個 JSON + 2 個 TXT
│   ├── icloud_username.txt
│   ├── icloud_app_password.txt
│   ├── google_oauth_client.json
│   ├── google_oauth_token.json
│   └── google_oauth_web.json
└── portal/               ← 整個目錄
    ├── package.json
    ├── package-lock.json
    ├── server.js
    ├── node_modules/     ← 在 Zeabur 上運行 npm install
    └── README.md
```

---

## ⚙️ Zeabur Dashboard 設定

### 1. Environment Variables (環境變數)

新增以下變數：

| 變數名稱 | 值 | 說明 |
|---------|-----|------|
| `PORT` | `3000` | 必須！Node.js 監聽端口 |
| `NODE_ENV` | `production` | 環境模式 |
| `TELEGRAM_BOT_TOKEN` | `<你的 Token>` | Telegram 機器人 Token |
| `STATIC_PORTAL_TOKEN` | `T628_TYLER_SAFE_ACCESS` | 網頁存取 Token |
| `FUGLE_API_KEY` | `<你的 Key>` | Finnhub 財經 API |
| `FINNHUB_API_KEY` | `<你的 Key>` | Finnhub API Key |
| `TAVILY_API_KEY` | `<你的 Key>` | 網頁搜尋 API |
| `OPENAI_API_KEY` | `<你的 Key>` | OpenAI API |
| `ANTHROPIC_API_KEY` | `<你的 Key>` | Anthropic API |
| `HUGGINGFACE_API_KEY` | `<你的 Key>` | 可選 |
| `MINIMAX_API_KEY` | `<你的 Key>` | 可選 |

### 2. Port Binding (端口綁定)

- 在 Service 設定中選擇 **3000**
- 勾選 **Auto Port Assignment** (全新部署需手動輸入 3000)

### 3. Build Command (建構命令)

```
npm install
```

### 4. Start Command (啟動命令)

```
node server.js
```

或者（如果 npm start 不夠）：```
PORT=3000 NODE_ENV=production node server.js
```

---

## 🚀 部署步驟

### 方法 A: Zeabur UI 部署

1. 登入 Zeabur Dashboard
2. 創建新的 Service → 選擇 Node.js
3. 上傳整個 `/workspace/portal/` 目錄
4. 新增所有 Environment Variables
5. 設定 Port 为 3000
6. 點擊 **Deploy**。

### 方法 B: 從 GitHub 部署（推薦）

1. 設定 `.gitignore` 在 `/workspace/`，確保：
   ```
   secrets/icloud_username.txt
   secrets/icloud_app_password.txt
   secrets/*.json
   → 不要上傳
   ```
2. 但 `secrets/*.txt` 檔案需要上傳！

**修正：** 需要創建前設 `.gitignore`：
```
secrets/*.json
workspace/portal/node_modules
```

所有配置應該在 Zeabur Dashboard 手動輸入，檔案只需上傳占位符：

```
/workspace/
└── portal/
    ├── .gitignore
    └── README.md
```

在 Dockerfile 或 Zeabur 記錄中，手動添加：
- API Keys
- Secrets .txt

---

## ✅ 驗證部署成功

### 1. Zeabur Log 檢查

```bash
deployment-list | 查看 Log 欄位
```

**成功訊息應該類似：**
```
[Portal] Portal server running on port 3000
[Portal] Sync Loop START
```

### 2. 測試連線

```bash
curl https://portal.zeabur.app/
```

**預期結果：** 200 OK

### 3. 測試 API

```bash
curl "https://portal.zeabur.app/api/calendar/upcoming?days=3&token=T628_TYLER_SAFE_ACCESS"
```

**預期結果：**
```json
{
  "items": [...],
  "source": "icloud",
  "timeZone": "Asia/Taipei"
}
```

---

## 🔧 常見問題

### 502 Bad Gateway
- ✅ 檢查 PORT 環境變數是否為 3000
- ✅ 檢查 Service Port 綁定是否正確
- ✅ 查看 Zeabur Log 有無錯誤

### Missing auth
- ✅ 確保額外 Token 已設定：`STATIC_PORTAL_TOKEN`

### iCloud 日曆為空
- ✅ 檢查 `secrets/` 是否已上傳並包含：
  - `icloud_username.txt`
  - `icloud_app_password.txt`

### Google Calendar 回退失敗
- ✅ 檢查可選 Token：
  - `google_oauth_token.json`
  - `google_oauth_client.json`

---

## 📝 重要提醒

1. **secrets 目錄必須上傳全部 5 個檔案**
2. **API Keys 填入 Environment Variables**
3. **PORT 必須設為 3000**
4. **node_modules 由 Zeabur 通過 npm install 自動安裝**
5. **首次部署可能需要 1-2 分鐘**