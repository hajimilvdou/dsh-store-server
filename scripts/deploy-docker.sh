#!/usr/bin/env bash
# =============================================================================
# 纯 docker 命令部署/构建（不依赖 docker compose 插件）：
#   拉取 GitHub Actions 构建好的 GHCR 镜像（或本地 docker build）→
#   建网络/数据卷 → 自动创建并启动 PostgreSQL 数据库容器 →
#   自动执行数据库迁移（一次性容器）→ 启动 Redis 与主程序容器 → /health 自检。
#
# 用法：
#   ./scripts/deploy-docker.sh            # 拉取 ghcr.io/<GH_IMAGE>:latest 部署
#   ./scripts/deploy-docker.sh --build    # 本地 docker build 后部署（源码构建方式）
#
# 依赖环境变量（可写入 .env，脚本自动读取）：
#   DB_PASSWORD（必填）、GH_IMAGE（默认 hajimilvdou/dsh-store-server）、TAG（默认 latest）、
#   PORT（默认 8080）、以及 GITHUB_TOKENS / GITHUB_OAUTH_* / JWT_SECRET / ADMIN_TOKEN 等（均可不填，
#   之后在管理端「配置中心」填写即热更新）。
# =============================================================================
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
DB_PASSWORD="${DB_PASSWORD:?请先复制 .env.example 为 .env 并设置 DB_PASSWORD（PostgreSQL 密码）}"
PORT="${PORT:-8080}"
TAG="${TAG:-latest}"
IMAGE="ghcr.io/${GH_IMAGE}:${TAG}"
NET="dshstore-net"
PG_VOL="dshstore-pg"
REDIS_VOL="dshstore-redis"
BUILD_LOCAL=0
RESET_DB=0
for _a in "$@"; do
  case "$_a" in
    --build) BUILD_LOCAL=1 ;;
    --reset-db) RESET_DB=1 ;;
    *) echo "未知参数：$_a（支持 --build / --reset-db）" >&2; exit 2 ;;
  esac
done

step() { echo "==> $*"; }

# 0) 镜像：本地构建 或 拉取 GHCR
if [[ $BUILD_LOCAL -eq 1 ]]; then
  step "本地构建镜像 ${IMAGE}"
  docker build -t "${IMAGE}" .
else
  step "拉取镜像 ${IMAGE}"
  if ! docker pull "${IMAGE}"; then
    echo "✗ 拉取失败：GHCR 镜像默认私有，首次请先登录：docker login ghcr.io -u <GitHub用户名> -p <PAT(read:packages)>" >&2
    echo "  或改用本地构建部署：./scripts/deploy-docker.sh --build" >&2
    exit 3
  fi
fi

# 1) 网络与数据卷（幂等）
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"
docker volume inspect "$PG_VOL" >/dev/null 2>&1 || docker volume create "$PG_VOL"
docker volume inspect "$REDIS_VOL" >/dev/null 2>&1 || docker volume create "$REDIS_VOL"

# 2) 数据库容器（自动创建；仅内网可见，不映射宿主机端口）
#    --network-alias db：网络内 `db` 与 `dshstore-db` 两个主机名都能解析（兼容 compose 风格的 @db:5432 写法）
step "启动数据库容器 dshstore-db（postgres:16-alpine）"
docker rm -f dshstore-db >/dev/null 2>&1 || true
if [[ $RESET_DB -eq 1 ]]; then
  step "重置数据库（删除旧数据卷，数据将被清空）"
  docker volume rm "$PG_VOL" >/dev/null 2>&1 || true
fi
docker run -d --name dshstore-db --network "$NET" --network-alias db --network-alias dshstore-db --restart unless-stopped \
  -v "$PG_VOL":/var/lib/postgresql/data \
  -e POSTGRES_USER=store -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=dshstore \
  postgres:16-alpine

step "等待数据库就绪"
READY=0
for _ in $(seq 1 30); do
  if docker exec dshstore-db pg_isready -U store -d dshstore >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[[ $READY -eq 1 ]] || { echo "✗ 数据库未就绪，请查看：docker logs dshstore-db" >&2; exit 4; }

# 3) Redis（可选依赖，起一个备用）
step "启动 redis dshstore-redis（redis:7-alpine）"
docker rm -f dshstore-redis >/dev/null 2>&1 || true
docker run -d --name dshstore-redis --network "$NET" --restart unless-stopped \
  -v "$REDIS_VOL":/data redis:7-alpine

# 4) 数据库迁移（一次性容器，完成即退出）
step "执行数据库迁移（dshstore-migrate）"
docker run --rm --name dshstore-migrate --network "$NET" \
  -e DATABASE_URL="postgres://store:${DB_PASSWORD}@dshstore-db:5432/dshstore" \
  -e MIGRATIONS_DIR=/app/db/migrations \
  "$IMAGE" node dist/db/migrate.js

# 5) 主程序容器
step "启动主程序容器 dshstore-api（端口 ${PORT}）"
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

# 6) 自检
step "自检 /health"
sleep 5
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "✅ 部署完成：数据库 + redis + 主程序容器已自动创建并运行"
  echo "   管理端：http://127.0.0.1:${PORT}/admin"
  docker ps --filter "name=dshstore-" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
  exit 0
fi
echo "✗ 自检失败，主程序最近日志（docker logs dshstore-api --tail 30）：" >&2
docker logs dshstore-api --tail 30 >&2 || true
exit 1
