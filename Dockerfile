# 使用 Dockerfile 為 Zeabur 部署（超穩定方案）

# 建立階段
FROM node:20-alpine

# 避免警告
LABEL maintainer="T W <tyler26@gmail.com>"
LABEL description="靈狐 Portal - Portfolio Tracker"

# 設定環境變數
ENV NODE_ENV=production
WORKDIR /app

# 複製 package（減少構建時間）
COPY package.json ./

# 安裝依賴
RUN npm install --omit=dev --no-optional

# 復製所有應用程式檔案（HTML, assets, public, etc.）
COPY . .

# 設定入口點
ENTRYPOINT ["node", "server.js"]

# 暴露端口（通常由 Zeabur 自動添加）
# EXPOSE 8080