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

# ---------- 模式 A：容器内热更新（docker socket + 重建脚本齐备时） ----------
if [[ -S /var/run/docker.sock ]] && command -v docker >/dev/null 2>&1 && [[ -f /opt/dsh-store/api.run.sh ]]; then
  NEW_IMAGE="ghcr.io/${GH_IMAGE}:${VERSION}"
  OLD_IMAGE="$(cat /opt/dsh-store/api.current-image 2>/dev/null || echo "ghcr.io/${GH_IMAGE}:${TAG}")"

  step "① 容器模式：拉取新镜像 ${NEW_IMAGE}"
  docker pull "${NEW_IMAGE}"

  step "② 由一次性编排容器重建 dshstore-api（迁移由新容器启动时自动执行）"
  # 编排容器跑在宿主 socket 上；api 容器被 rm 后本脚本随之终止，后续自检/回滚都在编排容器内完成
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /opt/dsh-store:/opt/dsh-store \
    --network "${NET}" \
    --entrypoint sh docker:cli -c '
      set -e
      IMAGE="$1"; OLD="$2"; NET="$3"
      echo "==> 拉取并重建 dshstore-api → $IMAGE"
      docker pull "$IMAGE" >/dev/null
      docker rm -f dshstore-api
      sh /opt/dsh-store/api.run.sh "$IMAGE"
      echo "==> 等待新容器自检 /health"
      sleep 10
      if docker exec dshstore-api wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo "$IMAGE" > /opt/dsh-store/api.current-image
        echo "✅ 面板热更新完成：$IMAGE"
      else
        echo "✗ 自检失败，回滚到 $OLD" >&2
        docker rm -f dshstore-api
        sh /opt/dsh-store/api.run.sh "$OLD"
        echo "已回滚到 $OLD" >&2
        exit 1
      fi
    ' sh "${NEW_IMAGE}" "${OLD_IMAGE}" "${NET}"

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
