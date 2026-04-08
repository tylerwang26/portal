#!/bin/bash
# Zeabur 部署腳本 - 修復 Portal
set -e

echo "🦊 靈狐 Portal 側舖部署流程"

# 1. 清理舊日誌與臨時文件
echo "1️⃣  清理舊文件..."
rm -f portal_stdout.log portal_stderr.log server.log zeabur_test.log
find . -name "*.log" -delete

# 2. 確認 secrets 檔案存在
echo "2️⃣  檢查秘鑰配置..."
if [ ! -f '../../secrets/icloud_username.txt' ]; then
    echo "❌ 缺少 iCloud 配置"
    exit 1
fi
if [ ! -f '../../secrets/icloud_app_password.txt' ]; then
    echo "❌ 缺少 iCloud 應用密碼"
    exit 1
fi
echo "✅ secrets 檔案完整"

# 3. 清理 node_modules 並重新安裝
echo "3️⃣  重新安裝依賴..."
rm -rf node_modules package-lock.json
npm install --production

# 4. 設定環境變數（如果需要手動部署）
export PORT=3000
export NODE_ENV=production
echo "4️⃣  環境變數已設定"
echo "   PORT=${PORT}"
echo "   NODE_ENV=${NODE_ENV}"

# 5. 啟動服務
echo "5️⃣  啟動 Portal server..."
nohup env PORT=${PORT} NODE_ENV=${NODE_ENV} node server.js > portal_stdout.log 2>&1 &
PORTAL_PID=$!

# 6. 等待啟動
echo "⏳ 等待服務啟動..."
sleep 5

# 7. 測試連線
echo "6️⃣  測試連線..."
if curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:${PORT}/; then
    echo "✅ Portal 已啟動並運行"
    echo "   PID: $PORTAL_PID"
    echo "   訪問: http://localhost:${PORT}"
else
    echo "⚠️ 連線測試 failed"
    echo "查看狀態: tail -100 portal_stdout.log"
fi

echo ""
echo "🎉 部署完成！"
