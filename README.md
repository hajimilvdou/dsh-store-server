# DSH 插件商城 · 服务端（dsh-store-server）

开源、多服务器可部署的 DSH 插件商店 **服务端**（独立仓库，与客户端 `dsh-store` 前端分开存放）。

- 客户端（dsh 插件）仓库：`dsh-store`（前端）
- 设计文档：`dsh-store-design-v3 ~ v3.7`；原型：`dsh-store-ui-prototype.html`
- 跨端契约：本仓库 `src/shared/`（与客户端共享同一份契约，发布 npm 后可改为依赖包）

## 目录结构

```
dsh-store-server/
├── src/
│   ├── shared/           # 跨端契约（协议/模型/API/配置）单一事实来源
│   ├── repo/             # 仓库：MemoryRepo（内存） / PgRepo（PostgreSQL 写穿）
│   ├── routes.ts         # REST 路由（公开 / 登录 / 联邦 / 管理端 / 管理面板）
│   ├── auth.ts           # GitHub OAuth + JWT（凭据缺失时休眠）
│   ├── sync/github.ts    # GitHub 同步管线（Search API 搜索 + 提取 + 星数快照 + 趋势榜）
│   ├── security/         # 安全扫描管线 + 限流守卫（读/写/认证分档，429+告警）
│   ├── clock.ts          # 时钟漂移自检（>500ms 告警，>5s 拒签凭证）
│   ├── config.ts         # 配置加载（环境变量覆盖 shared 默认值）
│   ├── db/               # PostgreSQL 连接池 + 迁移运行器
│   └── index.ts          # 启动入口（仓库选择 / 同步调度 / 时钟自检）
├── admin/index.html      # 管理端面板（服务端托管于 /admin，接 admin API）
├── db/migrations/        # 迁移脚本（001~008 随版本递增）
├── scripts/update.sh     # 一键更新预置流水线
├── scripts/deploy.sh     # compose 部署/升级（拉取失败自动回退本地构建）
├── scripts/deploy-docker.sh  # 纯 docker 命令部署/构建（无需 compose，自动建库/迁移/起容器）
├── scripts/deploy-remote.sh  # 零门槛一键远程部署（curl 直接执行，免拉仓库/免登录）
├── docker-compose.yml    # db + migrate + api + redis
└── .env.example
```

## 本地开发（无凭据）

```bash
npm install          # 依赖与缓存均落在工作区内（.npmrc 已配置 cache=.npm-cache）
npm run build        # 编译
npm run dev          # 启动（无 DATABASE_URL 时用内存仓库 + 假数据）
```

启动后：

- 数据通道：`GET /api/v1/manifest`、`GET /api/v1/plugins?since=`、`GET /api/v1/combos?since=`、`GET /api/v1/announcements`
- 匿名写接口：`POST /api/v1/anon-token`（换取匿名会话凭证）→ `POST /api/v1/downloads`（安装/下载计数，需 `X-Anon-Token`，同 token 同目标 1h 内去重，按天聚合产出 `downloads_7d`）
- 登录写接口：配置 OAuth 后为真实 GitHub OAuth JWT；**仅纯离线演示模式**（未配置 OAuth 且未配置 GitHub token）接受 `Authorization: Bearer mock-liwei` / `mock-xiaoyu`
- 点赞风控（v3.2 S8）：注册即赞 / 同 IP 多账号集中点赞 / 高频切换 → 自动隔离为"待确认"（不计入排行），管理端风控队列复核后生效或清除
- 管理端：`X-Admin-Token: <管理口令>`。口令 = 配置中心「管理员」密码 → 环境变量 `ADMIN_TOKEN` 兜底；纯离线演示模式默认 `mock-admin`。**生产环境两者皆未配置时管理端整体 503，无任何硬编码后门口令**

## 部署

### 🚀 零门槛一键部署（从零开始 · 免拉仓库 · 免登录）

服务器上只需装好 `docker`，执行下面这一条命令（脚本直接从 GitHub 下载执行，镜像拉取 Action 构建产物；仓库公开 → 镜像公开，无需登录）：

```bash
curl -fsSL https://raw.githubusercontent.com/hajimilvdou/dsh-store-server/main/scripts/deploy-remote.sh | bash
```

脚本自动完成：拉镜像 → 建网络/数据卷 → 起数据库容器（首次自动生成密码写入 `.env`）→ 迁移 → 起 redis + 主程序容器 → 自检。**重复执行 = 拉新镜像升级，数据不丢。**

带自定义参数运行（例如指定端口和管理口令）：

```bash
PORT=9000 ADMIN_TOKEN=你的强口令 bash <(curl -fsSL https://raw.githubusercontent.com/hajimilvdou/dsh-store-server/main/scripts/deploy-remote.sh)
```

### 其他方式（需要仓库 / 需要 compose）

```bash
cp .env.example .env      # 按注释填写占位符：DB_PASSWORD 必填；生产环境建议同时设置 ADMIN_TOKEN
```

### 方式 A：纯 docker 命令（无需 compose 插件，推荐）

一条脚本自动完成：拉取/构建镜像 → 建网络与数据卷 → **自动创建并运行数据库容器** → 自动迁移 → **自动创建并运行主程序容器**（+ redis）→ 自检：

```bash
./scripts/deploy-docker.sh            # 拉取 GitHub Actions 构建好的 GHCR 镜像部署
./scripts/deploy-docker.sh --build    # 改用本地 docker build 构建镜像后部署
```

容器清单（脚本自动创建，均 `--restart unless-stopped` 开机自愈）：`dshstore-db`（postgres:16-alpine，仅内网可见）、`dshstore-redis`、`dshstore-api`（映射 `${PORT:-8080}`）。管理端：`http://<服务器IP>:8080/admin`。

等价的纯命令构建方式（不使用脚本时）：

```bash
docker build -t ghcr.io/hajimilvdou/dsh-store-server:latest .   # 命令方式构建镜像
docker network create dshstore-net                               # 建网络
docker run -d --name dshstore-db --network dshstore-net \
  -v dshstore-pg:/var/lib/postgresql/data \
  -e POSTGRES_USER=store -e POSTGRES_PASSWORD=<DB_PASSWORD> -e POSTGRES_DB=dshstore postgres:16-alpine
docker run --rm --network dshstore-net \
  -e DATABASE_URL=postgres://store:<DB_PASSWORD>@dshstore-db:5432/dshstore \
  -e MIGRATIONS_DIR=/app/db/migrations \
  ghcr.io/hajimilvdou/dsh-store-server:latest node dist/db/migrate.js
docker run -d --name dshstore-api --network dshstore-net -p 8080:8080 \
  -e DATABASE_URL=postgres://store:<DB_PASSWORD>@dshstore-db:5432/dshstore \
  ghcr.io/hajimilvdou/dsh-store-server:latest
```

### 方式 B：docker compose

```bash
docker compose up -d            # 自动拉镜像（失败自动回退本地构建）：装库 → 迁移 → 起服务
./scripts/deploy.sh             # 同上，拉取失败自动回退本地构建 + /health 自检
```

compose 常见失败排查：

1. `docker compose` 命令不存在 → 机器没装 compose 插件，改用**方式 A**（纯 docker 命令）；
2. 拉取报 `unauthorized / denied` → GHCR 镜像默认私有，先 `docker login ghcr.io -u <GitHub用户名> -p <PAT(read:packages)>`；
3. 拉取报 `manifest unknown` → `.env` 里 `GH_IMAGE` 与仓库名不一致（本项目默认 `hajimilvdou/dsh-store-server`）；
4. 主程序报 `getaddrinfo ENOTFOUND dshstore-db`（或 `db`）→ api 容器与数据库容器**不在同一 docker 网络**：
   - 用 `./scripts/deploy-docker.sh` 一键部署（自动建网络并接线）；手工 `docker run` 时 api 与 db 都必须加 `--network dshstore-net`；
   - 确认数据库容器在跑：`docker ps | grep dshstore-db`；
5. 主程序日志出现 `null value in column "author"` → 镜像版本过旧（已修复），重新 `docker pull ghcr.io/hajimilvdou/dsh-store-server:latest` 或 `./scripts/deploy-docker.sh --build`。

密钥不在部署时必填：搜索 token（可多枚）、OAuth Client ID/Secret、JWT 密钥、管理员密码、注册开关与注册方式，均可在管理端「**配置中心**」修改（**每项独立保存**，保存即热更新；JWT 更换后全员重新登录）。生产环境务必配置：

1. 管理员口令：**首次打开管理页自动进入「首次使用 · 设置管理员密码」流程**（≥8 位，先到先得，部署后请尽快设置）；也可提前用 `ADMIN_TOKEN` 环境变量指定；
2. `GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET / JWT_SECRET`（GitHub 登录）；
3. `OAUTH_CALLBACK_URL`（反代/域名场景，需与 OAuth App 注册的回调地址完全一致）；
4. `GITHUB_TOKENS`（同步抓取 token 池）。

管理端「🔄 系统更新」页：手动**一键检测** GitHub 最新 Release + 检测源保存 + **一键在线更新**（容器部署走面板热更新：拉新镜像自动重建容器、失败自动回滚；宿主机 git 部署走 git 拉取→构建→迁移→切换→自检→回滚）+ **客户端插件版本推送**（版本号 + 安装地址，支持 `github:owner/repo` / `npm:包名` / 直链 tgz 三种写法，页面内附示例）。

> ⚠️ 面板热更新依赖把宿主 docker socket 挂进 api 容器（`deploy-remote.sh` / `deploy-docker.sh` 默认挂载）。
> 含义：拿到管理端口令即具备操作宿主机 docker 的能力，请务必保管好管理员密码；如不需要面板热更新，删除脚本中
> `-v /var/run/docker.sock:/var/run/docker.sock` 两行后重跑即可（此时面板会提示在宿主机执行更新命令）。

### GitHub Actions 构建 → 服务器直接拉取

上传到 GitHub 后，`.github/workflows/docker-build.yml` 自动构建镜像并推送到 **GHCR**（`ghcr.io/<owner>/<repo>`，镜像名已自动小写化，无需任何 Secrets，使用仓库自带 `GITHUB_TOKEN`）。服务器上无需构建：

```bash
# .env 中设置：GH_IMAGE=你的GitHub用户名/仓库名（本项目 = hajimilvdou/dsh-store-server）
docker compose pull && docker compose up -d      # 或直接：
./scripts/deploy.sh                              # 拉取镜像 → 迁移 → 启动 → /health 自检（拉取失败自动回退本地构建）
./scripts/deploy-docker.sh                       # 纯 docker 命令版（无需 compose 插件）
```

> GHCR 镜像可见性与仓库一致：**仓库公开 → 镜像公开，服务器直接 `docker pull`，无需登录**。
> 若拉取报 `unauthorized / denied`（镜像在仓库转公开之前构建过，仍为私有）：GitHub 仓库页 → Packages → 该镜像 → Package settings → Change visibility → Public；
> 或保持私有并在服务器登录一次：`docker login ghcr.io -u 你的GitHub用户名 -p <PAT>`（PAT 只需 `read:packages` 权限）。

镜像标签：分支名 / `v*` 版本标签 / `sha` / 默认分支附加 `latest`。

服务器本地直接构建镜像（不走 GHCR）：

```bash
./scripts/deploy-docker.sh --build   # 纯命令方式：docker build 后自动建库/迁移/起容器
docker compose up -d --build         # 或 compose 本地构建
```

## 升级 / 迁移 / 回滚 / 备份

```bash
# 升级（宿主机 git 检出部署：管理面板「系统更新」一键更新，失败自动回滚）
git fetch --tags && git checkout <新版本> && docker compose up -d --build
# 容器化部署升级：推荐直接点管理面板「系统更新 → 一键更新」（面板热更新，免登录服务器）
# 或宿主机执行：
GH_IMAGE=你的GitHub用户名/仓库名 ./scripts/deploy.sh
./scripts/deploy-docker.sh        # 纯 docker 命令部署方式：升级 = 重跑本脚本（自动拉新镜像并重建容器）
./scripts/deploy-remote.sh        # 远程一键部署：升级 = 重跑（同上）

# 迁移进度
docker compose exec db psql -U store -d dshstore -c "SELECT version FROM schema_migrations ORDER BY version;"
# 纪律：迁移只加不减；删除类变更延迟一个版本周期（expand-contract）

# 回滚（数据库无需回滚：expand-contract 保证旧代码兼容新表结构）
git checkout <旧版本> && docker compose up -d --build

# 备份 / 恢复
docker compose exec -T db pg_restore -U store -d dshstore --clean < 备份文件
```

## 磁盘策略

非必要数据默认保留 2 天自动清理（管理端可配 `retention.raw_data_days`，0 = 永久）；磁盘余量见管理面板「安全监控」。回滚/备份占用合计 < 3GB。

## 凭据清单（全部为占位符示例，真实值只放本机 gitignored 的 `.env` 或管理端配置中心，绝不入库）

| # | 凭据 | 用途 | 需要时机 |
|---|---|---|---|
| 1 | GitHub PAT ×3 | 抓取 token 池 | P0 真实同步联调 |
| 2 | GitHub OAuth App（Client ID/Secret） | 用户登录 | P1 登录联调 |
| 3 | LLM API Key | 翻译插槽（默认关） | P2 |
| 4 | 告警 Webhook | 监控告警 | P1 |
| 5 | 域名 + TLS | 对外服务 | 上线前 |
| 6 | 对象存储桶 | 每日备份 | 上线前 |

## 插件安装/卸载规范（对齐 DeepSeek Harness）

商城收录的每个插件都提取「安装 spec」（`install` 字段），与 dsh 真实插件管理机制一致：

| 动作 | 命令 | 说明 |
|---|---|---|
| 安装 | `dsh plugin --profile <name> add <install>` | 转发给 pnpm add；`install` 为 npm 包名（如 `dsh-memory`）或 git spec（如 `github:owner/repo`，未发布到 npm 时）；可锁版本 `add <install>@<version>` |
| 卸载 | `dsh plugin --profile <name> remove <pkg>` | 转发给 pnpm remove，自动从组合层移除 |
| 入组合层 | 自动 | 插件 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 即被加入 profile 的配置层栈 |

提取管线：仓库 `package.json` 的 `name` → npm 注册表校验（`registry.npmjs.org/<name>/latest` 取最新版本）→ 未发布则回落 `github:owner/repo`。

## 工作区约定

- 依赖（`node_modules`）与 npm 缓存（`.npm-cache/`）全部落在工作区内，不写入用户目录、不安装全局包、不修改系统环境。
- 本机验证仅用 `npm install / build / typecheck / dev`；Docker 镜像构建与容器启动属部署阶段，不在本机执行。
