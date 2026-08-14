#!/usr/bin/env bash
# 服务器一键部署/升级：拉取 GitHub Actions 构建好的镜像并启动（无需服务器上构建）。
# 用法：GH_IMAGE=你的GitHub用户名/仓库名 ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${GH_IMAGE:-}" ]]; then
  echo "请先在 .env 设置 GH_IMAGE（GitHub 用户名/仓库名），例如 GH_IMAGE=alice/dsh-store-server" >&2
  exit 2
fi

step() { echo "==> $*"; }

step "① 拉取镜像 ghcr.io/${GH_IMAGE}:latest"
docker compose pull

step "② 迁移（migrate 一次性服务）"
docker compose up -d migrate

step "③ 启动服务"
docker compose up -d --remove-orphans

step "④ 自检 /health"
sleep 5
if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "✅ 部署完成：ghcr.io/${GH_IMAGE}:latest"
  docker compose ps
  exit 0
fi

echo "❌ 自检失败，请查看日志：docker compose logs api" >&2
exit 1
