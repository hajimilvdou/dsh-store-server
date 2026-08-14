#!/usr/bin/env bash
# 服务器一键部署/升级（compose 方式）：
#   优先拉取 GitHub Actions 构建好的 GHCR 镜像；拉取失败（未登录 GHCR / 镜像不存在）
#   自动回退到本地 docker compose 构建，保证一条命令必然能起服务。
# 用法：GH_IMAGE=你的GitHub用户名/仓库名 ./scripts/deploy.sh
# 纯 docker 命令方式（无需 compose 插件）见：./scripts/deploy-docker.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 读取 .env（若存在）
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

GH_IMAGE="${GH_IMAGE:-hajimilvdou/dsh-store-server}"

# compose 插件识别：v2 = `docker compose`，老机器 = `docker-compose`（v1）
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "✗ 未找到 docker compose / docker-compose；请改用纯 docker 命令方式：./scripts/deploy-docker.sh" >&2
  exit 2
fi

step() { echo "==> $*"; }

if $COMPOSE pull; then
  step "① GHCR 镜像已拉取（ghcr.io/${GH_IMAGE}:latest）"
  step "② 迁移（migrate 一次性服务）"
  $COMPOSE up -d migrate
  step "③ 启动服务"
  $COMPOSE up -d --remove-orphans
else
  echo "⚠ 拉取失败（未登录 GHCR 或镜像不存在：docker login ghcr.io -u <用户名> -p <PAT>）→ 回退本地构建" >&2
  step "① 本地构建镜像"
  $COMPOSE build
  step "② 迁移（migrate 一次性服务）"
  $COMPOSE up -d migrate
  step "③ 启动服务"
  $COMPOSE up -d --remove-orphans
fi

step "④ 自检 /health"
sleep 5
if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "✅ 部署完成：ghcr.io/${GH_IMAGE}:latest"
  $COMPOSE ps
  exit 0
fi

echo "❌ 自检失败，请查看日志：$COMPOSE logs api" >&2
exit 1
