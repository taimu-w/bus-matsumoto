# ==========================================================
# バスリアルタイム運行管理システム バックエンド用イメージ
# ビルドコンテキストはプロジェクトルート（docker-compose.yml と同じ階層）を想定。
# frontend/ もそのままコピーし、server.js の相対パス参照(../../frontend)を維持する。
# ==========================================================
FROM node:18-alpine

WORKDIR /app

# 依存関係のインストール（キャッシュを効かせるため package.json のみ先にコピー）
COPY backend/package.json ./backend/package.json
RUN cd backend && npm install --omit=dev

# アプリ本体をコピー
COPY backend ./backend
COPY frontend ./frontend

WORKDIR /app/backend
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
