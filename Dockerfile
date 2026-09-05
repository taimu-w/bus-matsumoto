# ==========================================================
# バスリアルタイム運行管理システム バックエンド用イメージ
# ビルドコンテキストはプロジェクトルート（docker-compose.yml と同じ階層）を想定。
# frontend/ もそのままコピーし、server.js の相対パス参照(../../frontend)を維持する。
# ==========================================================
FROM node:20-alpine

WORKDIR /app

# 依存関係のインストール（キャッシュを効かせるため package.json / package-lock.json のみ先にコピー）
# package-lock.json に固定されたバージョンだけを再現インストールするため npm ci を使う
# （npm install と違い lockfile を書き換えず、lockfile と package.json の不一致があれば失敗する）。
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# アプリ本体と GTFS データをコピー
COPY backend ./backend
COPY frontend ./frontend
COPY ["data gtfs", "data gtfs"]

WORKDIR /app/backend
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
