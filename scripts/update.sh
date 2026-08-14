#!/usr/bin/env bash
# 一键更新预置流水线（v3.7 V2）：唯一参数为版本号，白名单格式 ^v\d+\.\d+\.\d+。
# 安全约束：只执行预置脚本，不存在任意命令执行面；失败自动回滚旧版本。
set -euo pipefail

VERSION="${1:?用法: update.sh <version>}"

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "非法版本号（要求 ^v\\d+\\.\\d+\\.\\d+）: $VERSION" >&2
  exit 2
fi

# 环境自检：本脚本面向"宿主机 git 检出 + docker compose"部署；
# 容器内（无 git/无 docker socket）无法自更新，给出明确指引而非报一堆底层错误。
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "当前环境不是 git 检出目录，无法执行源码级更新。" >&2
  echo "容器化部署请在宿主机执行：GH_IMAGE=用户名/仓库名 ./scripts/deploy.sh（拉取 GHCR 新镜像重启）" >&2
  exit 3
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker 命令：请在安装 docker + docker compose 的宿主机上执行更新。" >&2
  echo "容器化部署请执行：GH_IMAGE=用户名/仓库名 ./scripts/deploy.sh" >&2
  exit 3
fi

OLD_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo '')"

step() { echo "==> $*"; }

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
