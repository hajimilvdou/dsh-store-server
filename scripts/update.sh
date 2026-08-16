#!/usr/bin/env bash
# =============================================================================
# 一键更新预置流水线（v3.7 V2）：唯一参数为版本号，白名单格式 ^v\d+\.\d+\.\d+。
# 安全约束：只执行预置脚本（拉镜像/重建本服务容器），不存在任意命令执行面。
#
# 两种运行模式（自动探测）：
#   A. 容器模式（面板热更新）：api 容器内运行，宿主 docker socket 已挂载
#      （deploy-remote.sh / deploy-docker.sh 默认挂载）→ 拉新镜像 →
#      由一次性编排容器（docker:cli）重建 dshstore-api → 自检失败自动回滚旧镜像。
#   B. 宿主机模式：git 检出 + docker compose 部署 → git 拉取 → 构建 → 迁移 → 切换 → 失败回滚。
# =============================================================================
set -euo pipefail

VERSION="${1:?用法: update.sh <version|branch|sha>}"

# 白名单：release tag（v0.1 / v0.1.0）或 commit 通道（分支名 / sha，如 main）
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] && [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$ ]]; then
  echo "非法目标（release 通道要求 ^v\\d+\\.\\d+(\\.\\d+)?，commit 通道要求分支名/sha）: $VERSION" >&2
  exit 2
fi

GH_IMAGE="${GH_IMAGE:-hajimilvdou/dsh-store-server}"
TAG="${TAG:-latest}"
NET="${NET:-dshstore-net}"
step() { echo "==> $*"; }

# ---------- 模式 A：容器内热更新（挂载了宿主 docker socket 即可；重建脚本缺失时自动生成） ----------
if [[ -S /var/run/docker.sock ]] && command -v docker >/dev/null 2>&1; then
  PORT="${PORT:-8080}"
  mkdir -p /opt/dsh-store
  if [[ ! -f /opt/dsh-store/api.run.sh ]]; then
    step "首次面板更新：自动生成 /opt/dsh-store/api.run.sh"
    cat > /opt/dsh-store/api.run.sh <<RUNEOF
#!/usr/bin/env bash
set -euo pipefail
IMAGE="\${1:-ghcr.io/${GH_IMAGE}:${TAG}}"
docker run -d --name dshstore-api --network "${NET}" --restart unless-stopped \\
  -p "${PORT}:8080" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /opt/dsh-store:/opt/dsh-store \\
  -e DATABASE_URL="${DATABASE_URL:-}" \\
  -e PORT=8080 -e HOST=0.0.0.0 \\
  -e GH_IMAGE="${GH_IMAGE}" -e TAG="${TAG}" -e NET="${NET}" \\
  -e GITHUB_TOKENS="${GITHUB_TOKENS:-}" \\
  -e SYNC_TOPIC="${SYNC_TOPIC:-dsh-plugin}" \\
  -e SYNC_MAX_REPOS="${SYNC_MAX_REPOS:-0}" \\
  -e GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-}" \\
  -e GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-}" \\
  -e OAUTH_CALLBACK_URL="${OAUTH_CALLBACK_URL:-}" \\
  -e JWT_SECRET="${JWT_SECRET:-}" \\
  -e ADMIN_TOKEN="${ADMIN_TOKEN:-}" \\
  -e ACCESS_PASSWORD="${ACCESS_PASSWORD:-}" \\
  -e FEDERATION_ENABLED="${FEDERATION_ENABLED:-true}" \\
  -e FEDERATION_SECRET="${FEDERATION_SECRET:-}" \\
  -e UPDATE_REPO_URL="${UPDATE_REPO_URL:-}" \\
  -e CLUSTER_ID="${CLUSTER_ID:-}" \\
  "\$IMAGE"
RUNEOF
    chmod 700 /opt/dsh-store/api.run.sh
  fi
  [[ -f /opt/dsh-store/api.current-image ]] || echo "ghcr.io/${GH_IMAGE}:${TAG}" > /opt/dsh-store/api.current-image
  NEW_IMAGE="ghcr.io/${GH_IMAGE}:${VERSION}"
  OLD_IMAGE="$(cat /opt/dsh-store/api.current-image 2>/dev/null || echo "ghcr.io/${GH_IMAGE}:${TAG}")"

  step "① 容器模式：拉取新镜像 ${NEW_IMAGE}"
  docker pull "${NEW_IMAGE}"

  step "② 由一次性编排容器重建 dshstore-api（先执行数据库迁移，再重建 api）"
  # 编排容器跑在宿主 socket 上；api 容器被 rm 后本脚本随之终止，后续自检/回滚都在编排容器内完成
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /opt/dsh-store:/opt/dsh-store \
    --network "${NET}" \
    --entrypoint sh docker:cli -c '
      set -e
      IMAGE="$1"; OLD="$2"; NET="$3"; DBURL="$4"
      rm -f /opt/dsh-store/api.update-result
      echo "==> 执行数据库迁移（热更新自动带迁移）"
      if [ -n "$DBURL" ]; then
        docker run --rm --network "$NET" -e DATABASE_URL="$DBURL" "$IMAGE" node dist/db/migrate.js
      else
        echo "==> DATABASE_URL 为空，跳过迁移"
      fi
      echo "==> 拉取并重建 dshstore-api → $IMAGE"
      docker pull "$IMAGE" >/dev/null
      docker rm -f dshstore-api
      sh /opt/dsh-store/api.run.sh "$IMAGE"
      echo "==> 等待新容器自检 /health"
      sleep 10
      if docker exec dshstore-api wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo "$IMAGE" > /opt/dsh-store/api.current-image
        echo "OK $IMAGE" > /opt/dsh-store/api.update-result
        echo "✅ 面板热更新完成：$IMAGE"
      else
        echo "✗ 自检失败，回滚到 $OLD" >&2
        docker rm -f dshstore-api
        sh /opt/dsh-store/api.run.sh "$OLD"
        echo "FAIL $OLD" > /opt/dsh-store/api.update-result
        echo "已回滚到 $OLD" >&2
        exit 1
      fi
    ' sh "${NEW_IMAGE}" "${OLD_IMAGE}" "${NET}" "${DATABASE_URL:-}"

  echo "面板热更新流水线已执行完毕（结果见上方输出）"
  exit 0
fi

# ---------- 模式 B：宿主机 git 检出 + docker compose ----------
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "当前环境不是 git 检出目录，且未检测到容器内热更新条件（docker socket + /opt/dsh-store/api.run.sh）。" >&2
  echo "容器化部署（面板热更新）：请用 ./scripts/deploy-remote.sh 重新部署一次（会自动挂载 docker socket 并生成重建脚本）" >&2
  echo "或在宿主机执行：GH_IMAGE=用户名/仓库名 ./scripts/deploy.sh" >&2
  exit 3
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker 命令：请在安装 docker + docker compose 的宿主机上执行更新。" >&2
  exit 3
fi

OLD_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo '')"

step "① 拉取: git fetch --tags && git checkout $VERSION"
git fetch --tags
git checkout "$VERSION"

step "② 构建: docker compose build"
docker compose build

step "③ 迁移: docker compose up -d migrate"
docker compose up -d migrate

step "④ 切换: docker compose up -d api"
docker compose up -d api

step "⑤ 自检: /health"
sleep 5
if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "自检通过：已从 ${OLD_VERSION:-unknown} 升级到 $VERSION"
  exit 0
fi

echo "自检失败，尝试回滚" >&2
if [[ -n "$OLD_VERSION" ]]; then
  git checkout "$OLD_VERSION"
else
  echo "仓库无历史 tag，无法回滚到旧版本；请手动处理：git checkout <上一版本> && docker compose up -d --build" >&2
  exit 1
fi
docker compose up -d --build
echo "已回滚到 $OLD_VERSION" >&2
exit 1
