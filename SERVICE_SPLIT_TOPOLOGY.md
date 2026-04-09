# Portal → 6-Service 分拆架構

**更新日期**: 2026-04-09
**狀態**: 🔄 進行中（本機 repo 已建立，待推送至 GitHub 並在 Zeabur 部署）

---

## 服務清單

| # | 名稱 | GitHub | Zeabur Service ID | 內部位址 | 狀態 |
|---|------|--------|--------------------|----------|------|
| 0 | memory-ops | tylerwang26/memory-ops | service-69956d0646ce828f10f1582f | memory-ops.zeabur.internal:8080 | ✅ 本機 repo 完成 |
| 1 | twai (OpenClaw AI) | tylerwang26/twai | service-69d36f3d93577fe0061de61d | openclaw-twai.zeabur.internal:18789 | ⏳ 尚未初始化 |
| 2 | Portl (Portal) | tylerwang26/Portl | service-69d601259da252559b38d61a | portal.zeabur.internal:8080 | ✅ i-chat 已移除 |
| 3 | Stock | tylerwang26/i-stock | service-69d49e84327f44a3cdec287f | i-stock.zeabur.internal:8080 | ✅ 本機 repo 完成 |
| 4 | Explorer (前 Worker) | tylerwang26/fileexplorer | 待建立 | 待建立 | ✅ 本機 repo 完成 |
| 5 | i-Chat | tylerwang26/i-chat | 待建立 | 待建立 | ✅ 本機 repo 完成 |

---

## 本機 Repo 路徑

| Service | 本機路徑 |
|---------|---------|
| memory-ops | /Users/tyler26/Git/memory-ops/ |
| Portl (Portal) | /Users/tyler26/Git/portal/ |
| i-Chat | /Users/tyler26/Git/i-chat/ |

---

## 架構拓撲

```
用戶 (Web / Telegram / Discord)
  |
  +-> #2 Portl (portal.zeabur.internal:8080)
       +-> #1 twai (openclaw-twai.zeabur.internal:18789)
       |    +-- #0 memory-ops (memory-ops.zeabur.internal:8080)
       |    +-- RAG LanceDB
       |    +-- GraphRAG
       |
       +-> #3 Stock (i-stock.zeabur.internal:8080)
       +-> #4 Explorer
       +-> #5 i-Chat
```

---

## 服務詳細說明

### #0 memory-ops

- 角色: AI 記憶 sidecar，無 LLM，純 JSON 儲存
- 技術棧: Python + FastAPI + uvicorn
- 本機: /Users/tyler26/Git/memory-ops/
- 端口: 8080 (PORT 環境變數)
- Zeabur ID: service-69956d0646ce828f10f1582f

端點: GET /health, POST /memories, GET /search, POST /reset

---

### #1 twai (OpenClaw AI)

- 角色: AI 推理引擎 + 記憶管理
- 端口: 18789
- GitHub: tylerwang26/twai
- Zeabur ID: service-69d36f3d93577fe0061de61d
- 備份: workspace/rag/lancedb/ + workspace/deep-graph-rag/
- 狀態: ⏳ 尚未設置

---

### #2 Portl (Portal)

- 角色: Web UI + API Gateway
- 技術棧: Node.js / Express (server.js)
- 本機: /Users/tyler26/Git/portal/
- 端口: 8080
- GitHub: tylerwang26/Portl
- Zeabur ID: service-69d601259da252559b38d61a

已完成:
- ✅ 移除所有 i-chat 路由（253 行）
- ✅ 移除 ICHAT_STATE, iChatKey() 等 5 個函式
- ✅ Internal webhook -> logs/portal_webhook.log

---

### #3 Stock

- 角色: 市場數據 + 交易信號
- GitHub: `tylerwang26/i-stock`
- Service ID: `service-69d49e84327f44a3cdec287f`
- Internal: `i-stock.zeabur.internal:8080`

---

### #4 Explorer（前 Worker）

- 角色: 非同步任務、檔案瀏覽
- GitHub: tylerwang26/fileexplorer
- Zeabur ID: 待建立
- 狀態: ⏳ 尚未設置

---

### #5 i-Chat

- 角色: AI 聊天 UI + 歷史記錄
- 技術棧: Node.js / Express (server.cjs) + 靜態 HTML + KaTeX
- 本機: /Users/tyler26/Git/i-chat/
- 端口: 8080 (PORT 環境變數)
- GitHub: tylerwang26/i-chat
- Zeabur ID: 待建立
- 備份: workspace/i-chat-frontend/i-chat-service/

端點: GET /, GET /health, POST /api/message, GET /api/i-chat/state, GET /api/i-chat/history, POST /api/i-chat/stream

---

## 實施進度

### ✅ 已完成

- [x] Step 3: Portal server.js 全面移除 i-chat 程式碼（253 行 + 5 個函式）
- [x] Step 1: memory-ops repo 初始化 -> /Users/tyler26/Git/memory-ops/
- [x] Step 4: i-chat repo 初始化 -> /Users/tyler26/Git/i-chat/

### ⏳ 待完成

- [ ] Step 2: twai repo 初始化（OpenClaw AI 服務）
- [ ] GitHub push:
  - memory-ops: git remote add origin https://github.com/tylerwang26/memory-ops.git && git push -u origin main
  - i-chat: git remote add origin https://github.com/tylerwang26/i-chat.git && git push -u origin main
  - portal: git remote add origin https://github.com/tylerwang26/Portl.git && git push -u origin main
- [ ] Zeabur 部署:
  - memory-ops: 設定 MEMORY_DIR=/data/memory，掛載 Volume
  - i-chat: 建立新服務，設定 SESSION_SECRET, STATIC_PORTAL_TOKEN
- [ ] Portal 前端: i-chat.html API 呼叫指向 i-chat 服務域名

---

## 備份來源

```
/tmp/2026-03-28T19-00-05.722Z-openclaw-backup/
  payload/posix/home/node/.openclaw/workspace/
    +-- memory-ops/              FastAPI sidecar（已用）
    +-- rag/lancedb/             LanceDB 向量索引（-> twai）
    +-- deep-graph-rag/          GraphRAG 3.2MB（-> twai）
    +-- scripts/                 Python 工具（-> twai / Explorer）
    +-- i-chat-frontend/
         +-- i-chat-service/     i-chat 最新版（已用）
```
