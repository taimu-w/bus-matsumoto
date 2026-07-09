#!/bin/sh
# コンテナ起動時の初期化スクリプト。
# schema.sql / seed.js はどちらも冪等（IF NOT EXISTS / ON CONFLICT）なので、
# 起動のたびに実行しても安全。DB起動直後の接続失敗に備えてリトライする。
set -e

RETRIES=15
until node src/db/migrate.js; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[entrypoint] データベースへの接続に失敗しました。終了します。"
    exit 1
  fi
  echo "[entrypoint] データベース接続待機中... 残り試行回数: $RETRIES"
  sleep 3
done

echo "[entrypoint] マスタデータを投入します（バス停・時刻表）。"
node src/db/seed.js

echo "[entrypoint] サーバーを起動します。"
exec node src/server.js
