#!/bin/bash
# Portal 修復與重新部署腳本
set -e

echo "🦊 靈狐 Portal 修復工具 v1.0"

# 錯誤處理
error_exit() {
    echo "❌ ERROR: $1"
    exit 1
}

# 1. 清理舊文件
echo ""
echo "1️⃣  清理..."
rm -f /home/node/.openclaw/workspace/portal/portal_*.log
find /home/node/.openclaw/workspace -name "*.log" -type f -delete 2>/dev/null || true
echo "✅ 清理完成"

# 2. 檢查 secrets
echo ""
echo "2️⃣  檢查 secrets..."
if [ ! -f "/home/node/.openclaw/workspace/secrets/icloud_username.txt" ]; then
    error_exit "缺少 icloud_username.txt"
fi
if [ ! -f "/home/node/.openclaw/workspace/secrets/icloud_app_password.txt" ]; then
    error_exit "缺少 icloud_app_password.txt"
fi
echo "✅ secrets 完整"

# 3. 安裝依賴
echo ""
echo "3️⃣  安裝依賴..."
cd /home/node/.openclaw/workspace/portal
rm -rf node_modules package-lock.json
npm install --production
echo "✅ 依賴安裝完成"

# 4. 啟動服務
echo ""
echo "4️⃣  啟動 Portal..."
export PORT=3000
export NODE_ENV=production

nohup env PORT=${PORT} NODE_ENV=${NODE_ENV} node server.js > portal_stdout.log 2>&1 &
PID=$!

echo "✅ Portal 已啟動 (PID: $PID)"

# 5. 等待啟動
echo ""
echo "⏳ 等待服務啟動..."
sleep 8

# 6. 測試連線
echo ""
echo "5️⃣  測試連線..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORT}/)
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ HTTP $HTTP_CODE - 服務正常"
else
    echo "⚠️ HTTP $HTTP_CODE - 請檢查 Log"
    tail -30 portal_stdout.log
fi

# 7. 測試日均 API
echo ""
echo "6️⃣  測試 Calendar API..."
TOKEN="T628_TYLER_SAFE_ACCESS"
API_RESPONSE=$(curl -s "http://localhost:${PORT}/api/calendar/upcoming?days=3&token=${TOKEN}")

if echo "$API_RESPONSE" | grep -q "items"; then
    EVENTS_COUNT=$(echo "$API_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items', [])))" 2>/dev/null || echo "0")
    echo "✅ API 正常 - 發現 $EVENTS_COUNT 個行程"
else
    echo "⚠️ API 可能失敗"
    echo "$API_RESPONSE"
fi

echo ""
echo "🎉 修復完成！"
echo ""
echo "📋 服務狀態:"
echo "   URL: http://localhost:${PORT}"
echo "   PID: $PID"
echo "   Log: portal_stdout.log"
echo ""
echo "🚀 部署到 Zeabur:"
echo "   1. 查看 DEPLOY.md 部署說明"
echo "   2. 上傳 secrets 目錄到 Zeabur"
echo "   3. 設定 PORT=3000 環境變數"
echo "   4. Redeploy"