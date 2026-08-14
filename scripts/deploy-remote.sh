#!/usr/bin/env bash
# =============================================================================
# 一键远程部署（从零开始 · 免拉仓库 · 免登录）：
#
#   curl -fsSL https://raw.githubusercontent.com/hajimilvdou/dsh-store-server/main/scripts/deploy-remote.sh | bash
#
# 流程：拉取 GitHub Action 构建好的 GHCR 镜像（仓库公开 → 镜像公开，免登录）→
#       建网络/数据卷 → 自动起数据库容器（首次自动生成密码写入 .env）→
#       自动迁移 → 起 redis + 主程序容器 → /health 自检。
# 重复执行 = 拉新镜像升级（数据卷持久化，不丢数据）。
# 可选环境变量（放在命令前）：DB_PASSWORD / GH_IMAGE / TAG / PORT / ADMIN_TOKEN / GITHUB_TOKENS ...
# =============================================================================
set -euo pipefail

# 读取当前目录已有的 .env（首次运行没有也正常）
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

GH_IMAGE="${GH_IMAGE:-hajimilvdou/dsh-store-server}"
TAG="${TAG:-latest}"
PORT="${PORT:-8080}"
IMAGE="ghcr.io/${GH_IMAGE}:${TAG}"
NET="dshstore-net"
PG_VOL="dshstore-pg"
REDIS_VOL="dshstore-redis"

# 参数：--reset-db = 删除旧数据库数据卷重新初始化（旧密码对不上 / 数据损坏时用）
RESET_DB=0
for _a in "$@"; do
  case "$_a" in
    --reset-db) RESET_DB=1 ;;
    *) echo "未知参数：$_a（支持 --reset-db）" >&2; exit 2 ;;
  esac
done

# 首次运行：数据库密码自动生成并持久化到 .env（重跑/重启不丢库）
if ! grep -q '^DB_PASSWORD=' .env 2>/dev/null; then
  if [[ -z "${DB_PASSWORD:-}" ]]; then
    DB_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    echo "==> 首次运行：已自动生成数据库密码（如需自定义，编辑 .env 的 DB_PASSWORD 后重跑）"
  fi
  { [[ -f .env ]] && echo ""; } >> .env
  echo "DB_PASSWORD=${DB_PASSWORD}" >> .env
fi

step() { echo "==> $*"; }

step "① 拉取 Action 构建的镜像 ${IMAGE}"
if ! docker pull "${IMAGE}"; then
  echo "✗ 拉取失败：仓库公开则镜像公开无需登录；若仍报 unauthorized，请 docker login ghcr.io -u <用户名> -p <PAT> 后重试" >&2
  exit 3
fi

step "② 网络与数据卷（幂等）"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"
docker volume inspect "$PG_VOL" >/dev/null 2>&1 || docker volume create "$PG_VOL"
docker volume inspect "$REDIS_VOL" >/dev/null 2>&1 || docker volume create "$REDIS_VOL"

step "③ 启动数据库容器 dshstore-db（网络内别名：db / dshstore-db）"
docker rm -f dshstore-db >/dev/null 2>&1 || true
if [[ $RESET_DB -eq 1 ]]; then
  step "③.1 重置数据库（删除旧数据卷，数据将被清空）"
  docker volume rm "$PG_VOL" >/dev/null 2>&1 || true
fi
docker run -d --name dshstore-db --network "$NET" --network-alias db --network-alias dshstore-db --restart unless-stopped \
  -v "$PG_VOL":/var/lib/postgresql/data \
  -e POSTGRES_USER=store -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=dshstore \
  postgres:16-alpine

step "④ 等待数据库就绪"
READY=0
for _ in $(seq 1 30); do
  if docker exec dshstore-db pg_isready -U store -d dshstore >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[[ $READY -eq 1 ]] || { echo "✗ 数据库未就绪，请查看：docker logs dshstore-db" >&2; exit 4; }

step "⑤ 启动 redis dshstore-redis"
docker rm -f dshstore-redis >/dev/null 2>&1 || true
docker run -d --name dshstore-redis --network "$NET" --restart unless-stopped \
  -v "$REDIS_VOL":/data redis:7-alpine

step "⑥ 数据库迁移（一次性容器）"
if ! docker run --rm --name dshstore-migrate --network "$NET" \
  -e DATABASE_URL="postgres://store:${DB_PASSWORD}@dshstore-db:5432/dshstore" \
  -e MIGRATIONS_DIR=/app/db/migrations \
  "$IMAGE" node dist/db/migrate.js; then
  echo "✗ 迁移失败。" >&2
  echo "  常见原因：数据库数据卷是旧密码初始化的（postgres 只认首次初始化时的密码）。" >&2
  echo "  修复（重置数据库，旧数据将被清空）后重跑本脚本：" >&2
  echo "    docker rm -f dshstore-db && docker volume rm dshstore-pg" >&2
  echo "  或一条命令（新版脚本支持 --reset-db）：" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/hajimilvdou/dsh-store-server/main/scripts/deploy-remote.sh | bash -s -- --reset-db" >&2
  echo "  或改回旧密码：编辑 .env 的 DB_PASSWORD=首次初始化时的密码 后重跑。" >&2
  exit 5
fi

step "⑦ 启动主程序容器 dshstore-api（端口 ${PORT}）"
docker rm -f dshstore-api >/dev/null 2>&1 || true
docker run -d --name dshstore-api --network "$NET" --restart unless-stopped \
  -p "${PORT}:8080" \
  -e DATABASE_URL="postgres://store:${DB_PASSWORD}@dshstore-db:5432/dshstore" \
  -e PORT=8080 -e HOST=0.0.0.0 \
  -e GITHUB_TOKENS="${GITHUB_TOKENS:-}" \
  -e SYNC_TOPIC="${SYNC_TOPIC:-dsh-plugin}" \
  -e SYNC_MAX_REPOS="${SYNC_MAX_REPOS:-0}" \
  -e GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-}" \
  -e GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-}" \
  -e OAUTH_CALLBACK_URL="${OAUTH_CALLBACK_URL:-}" \
  -e JWT_SECRET="${JWT_SECRET:-}" \
  -e ADMIN_TOKEN="${ADMIN_TOKEN:-}" \
  -e ACCESS_PASSWORD="${ACCESS_PASSWORD:-}" \
  -e FEDERATION_ENABLED="${FEDERATION_ENABLED:-true}" \
  -e FEDERATION_SECRET="${FEDERATION_SECRET:-}" \
  -e UPDATE_REPO_URL="${UPDATE_REPO_URL:-https://github.com/hajimilvdou/dsh-store-server}" \
  -e CLUSTER_ID="${CLUSTER_ID:-}" \
  "$IMAGE"

step "⑧ 自检 /health"
sleep 5
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "✅ 部署完成（镜像：${IMAGE}）"
  echo "   管理端：http://<服务器IP>:${PORT}/admin"
  docker ps --filter "name=dshstore-" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
  exit 0
fi
echo "✗ 自检失败，主程序最近日志：" >&2
docker logs dshstore-api --tail 30 >&2 || true
exit 1
