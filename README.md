# dsh-store-server

**DSH 插件商城 · 服务端** —— 开源、多服务器可部署的 DSH 插件商店后端（独立仓库）。

配合客户端插件 [dsh-storecloud](https://github.com/hajimilvdou/dsh-storecloud) 使用：部署本服务端 → 客户端插件指向它 → DSH 用户即可在界面里浏览、搜索、一键安装插件与 Agent 预设。

> 📌 配套客户端见 [dsh-storecloud](https://github.com/hajimilvdou/dsh-storecloud)（悬浮球 / 设置页 / 会话视图三入口 + 本地安装器 + 反向代理桥）。
> 两者联动：服务端提供全部数据与写接口；客户端负责展示与本地安装。默认也提供**作者的服务器**开箱即用（不部署本仓库也能体验完整商城）。

---

## ✨ 功能介绍

### 1. 插件库 —— GitHub 自动收录

- 按 **`topic:dsh-plugin`** 搜索 GitHub 仓库，自动收录插件与 Agent 预设；
- 多 token 池轮换抓取、页间限速防限流（Search API 30 次/分钟），进度与结果全程可视化；
- 自动提取：README 简介、分类、**安装 spec**（`package.json` 的 `name` → npm 注册表校验取最新版本 → 未发布自动回落 `github:owner/repo`）；
- 星数快照 + **7 天趋势榜**（`stars_7d`），趋势 / 热门 / 最新多维排序。

### 2. 组合（combos）—— 插件组的云端家园

服务端是客户端「**插件组**」功能的云端支撑：别人推荐的组合、你创建的组合都存在这里，客户端一键整组安装：

- 组合 CRUD：成员（插件 / Agent 预设）+ **安装模式**（直接安装 / 安装前询问 / 跳过）+ **启动复核**开关；
- **订阅计数**：按组合聚合订阅数，推荐/热门排序；自动发布（草稿 → 发布）、心跳增量同步（周期可配，默认 30 分钟）；
- 推荐标记（管理员）、过期组合自动清理（宽限期内保留订阅与配额）。

### 3. 云端账号 —— 换环境一键拉回自己的插件

- **GitHub OAuth 登录 / 注册** + JWT 签发（凭据缺失时自动休眠，纯离线演示模式另设 mock 账号）；
- 用户维度云端台账：创建的组合、订阅的组合、安装/下载记录；
- 客户端登录后**一键拉取自己的组合与已装清单**，换开发环境无需重新查找记录（联动 dsh-storecloud「云端同步」）；
- 用户状态管理：注册开关、封禁（即时生效）、注销（硬删除即时释放配额）。

### 4. 联邦互联 —— 多服务器互连

- 服务器间握手 + **联邦密码互换**（`peer_secret`）建立关系，管理端可视化联邦关系表；
- **可选择共享种类**：插件 / Agent 预设 / 组合 / 用户，按需勾选；
- 增量同步 + 心跳保活（首轮 10 分钟后进入周期，24h 默认可配）；**单向解约即断开**，对方收到通知并保留已同步数据；
- 联邦接口独立 `X-Federation-Secret` 鉴权，不与管理端口令混用。

### 5. 安全

- 读写**限流分档**守卫（读/写/认证分别限速，429 + 告警 Webhook 热更新）；
- **点赞风控**：注册即赞 / 同 IP 多账号集中点赞 / 高频切换 → 自动隔离为「待确认」（不计入排行），管理端复核后生效或清除；
- **时钟漂移自检**：>500ms 告警，>5s 拒签凭证；
- 所有密钥只来自环境变量或配置表（**绝不入库/写死**）；生产未配置管理员口令时管理端整体 503，无任何硬编码后门口令；
- 匿名写接口强制 `X-Anon-Token`（1h 同目标去重计数），下载/安装计数可信。

### 6. 管理端（/admin）—— 一体化控制台

- **仪表盘**：同步进度 / 联邦关系 / 风险队列 / 安全监控 / 磁盘余量；
- **配置中心**：搜索 token 池、OAuth、JWT、管理员密码、联邦密码、访问口令、注册开关等——**每项独立保存、保存即热更新**，密码类只显示「已配置/未配置」；
- **风控队列**：点赞/风险事件复核（计入排行或清除）；
- **系统更新**：一键检测 GitHub 最新 Release + **一键在线更新**（容器部署走面板热更新：拉新镜像 → 自动迁移 → 重建容器 → 自检，失败自动回滚；宿主机部署走 git 拉取 → 构建 → 迁移 → 切换 → 回滚）；
- **客户端插件版本推送**：配置版本号 + 安装地址（`github:owner/repo` / `npm:包名` / 直链 tgz 三种写法），客户端自动提示更新；
- 首次使用强制设置管理员密码（≥8 位，先到先得）。

### 7. 实时与公告

- SSE 实时通道：公告 / 插件库更新 / 点赞事件推送（客户端未读标记）；
- 公告管理（管理端发布、上下架）。

### 8. 部署与运维

- **零门槛一键远程部署**：服务器只要装了 docker，一条 `curl | bash` 从零拉起（拉镜像 → 建库 → 迁移 → 起服务 → 自检），重复执行即升级且数据不丢；
- GitHub Actions 自动构建 **GHCR 镜像**（无需任何 Secrets），服务器直接 `docker pull`；
- 迁移**只加不减**（expand-contract），回滚无需还原数据库；升级自动带迁移 + 自检 + 自动回滚；
- 非必要数据默认保留 2 天自动清理（管理端可配），磁盘占用可控；备份/恢复一键执行。

---

## 快速开始（部署）

### 🚀 零门槛一键部署（从零开始 · 免拉仓库 · 免登录）

服务器上只需装好 `docker`，执行下面这一条命令（脚本直接从 GitHub 下载执行；仓库公开 → 镜像公开，无需登录）：

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

**方式 A：纯 docker 命令（无需 compose 插件，推荐）**

```bash
./scripts/deploy-docker.sh            # 拉取 GitHub Actions 构建好的 GHCR 镜像部署
./scripts/deploy-docker.sh --build    # 改用本地 docker build 构建镜像后部署
```

容器清单（脚本自动创建，均 `--restart unless-stopped` 开机自愈）：`dshstore-db`（postgres:16-alpine，仅内网可见）、`dshstore-redis`、`dshstore-api`（映射 `${PORT:-8080}`）。管理端：`http://<服务器IP>:8080/admin`。

**方式 B：docker compose**

```bash
docker compose up -d            # 自动拉镜像（失败自动回退本地构建）：装库 → 迁移 → 起服务
./scripts/deploy.sh             # 同上，拉取失败自动回退本地构建 + /health 自检
```

### 生产环境务必配置

1. 管理员口令：**首次打开管理页自动进入「首次使用 · 设置管理员密码」流程**（≥8 位，先到先得，部署后请尽快设置）；也可提前用 `ADMIN_TOKEN` 环境变量指定；
2. `GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET / JWT_SECRET`（GitHub 登录）；
3. `OAUTH_CALLBACK_URL`（反代/域名场景，需与 OAuth App 注册的回调地址完全一致）；
4. `GITHUB_TOKENS`（同步抓取 token 池）。

密钥不在部署时必填：搜索 token（可多枚）、OAuth、JWT、管理员密码、注册开关等均可在管理端「**配置中心**」修改（每项独立保存、保存即热更新；JWT 更换后全员重新登录）。

---

## 使用说明

### 1. 获取 GitHub 搜索 token（同步插件库必需）

插件库的自动收录依赖 GitHub Search API，需要一枚 **classic PAT**：

1. 打开 GitHub → 右上角头像 → **Settings** → 左侧 **Developer settings** → **Personal access tokens** → **Tokens (classic)**；
2. 点 **Generate new token (classic)**，Note 随意（如 `dsh-store-sync`），有效期自选；
   - 权限（Scopes）：**只需公开库搜索，全部不勾选即可**（Search API 认证请求即可获得 30 次/分钟额度；如提示权限不足可勾选 `public_repo`）；
3. 生成后**立即复制**（只显示一次），形如 `ghp_xxxxxxxxxxxxxxxxxxxx`；
4. 填入本服务端（二选一）：
   - **管理端 → 配置中心 → 搜索 token**（一行一枚，可填多枚自动轮换，保存即热更新），或
   - 环境变量 `GITHUB_TOKENS`（逗号分隔多枚）；
5. 保存后同步自动启用：`SYNC_TOPIC` 默认为 `dsh-plugin`（只收录打了该 topic 的仓库），管理端可随时「▶ 立即抓取」。

> 未配置搜索 token 时：同步与登录功能休眠，其余（浏览/下载计数/管理端）不受影响。

### 2. 登录配置（用户 GitHub 登录）

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**：
   - Homepage URL：你的服务器地址；
   - **Authorization callback URL：必须与管理端配置的 `OAUTH_CALLBACK_URL` 完全一致**（默认按请求 host 拼接，反代/域名场景需显式设置）；
2. 拿到 **Client ID / Client Secret**，连同自拟的 **JWT_SECRET**（签名密钥，≥16 位随机串）填入管理端配置中心（或环境变量）；
3. 保存即生效（JWT 更换后全员重新登录）。

配置完成后，用户在客户端「我的」页点「立即登录 GitHub」→ 新窗口完成授权 → **token 自动回传并存到本地**，全程无需复制粘贴。

### 3. 管理端登录（管理员）

- **首次使用**：打开 `http://<服务器>:8080/admin` → 进入「首次使用 · 设置管理员密码」流程（≥8 位，先到先得）→ 之后用该密码登录；
- 也可部署时用环境变量 `ADMIN_TOKEN` 预置口令；生产环境两者皆未配置时管理端整体 503（防后门）；
- 登录后 token（`X-Admin-Token`）自动保存在浏览器本地（`dshs_admin_token`），下次打开免输入；
- 管理端登录口令与用户登录（OAuth）完全独立，互不影响。

### 4. 客户端登录 token 在哪

- 用户登录 token 由 OAuth 授权后**自动回传**，保存在客户端浏览器本地存储（`dsh_store_token`），**不需要手动获取或粘贴**；
- 换电脑/换环境：重新打开商城「我的」→ 登录一次即可，云端组合/订阅/安装记录自动拉回；
- 未登录也能浏览、搜索、安装插件（数据通道开放）；登录仅用于云端同步与社区功能（发布插件/组合、订阅、点赞）；
- 纯离线演示模式（未配置 OAuth 且未配置搜索 token）下，接受 `Authorization: Bearer mock-liwei` / `mock-xiaoyu` 演示账号。

### 5. 组合更新频率在哪调

- 客户端（插件商城面板）的组合/插件数据**不是实时推送**，按服务端下发的周期心跳拉取（默认 **30 分钟**）；
- 调整位置：**管理端 → 配置中心 →「📡 客户端更新频率」**→「组合/数据更新间隔（分钟）」（`sync.data_heartbeat_min`），保存即热更新、即时下发到客户端；
- 客户端「我的」页也会显示当前频率（"📡 组合更新频率：每 X 分钟"），提示管理员去服务端调整；
- 调小 = 更实时（更耗流量/请求），调大 = 更省资源；组合详情页/订阅页另有手动刷新。

### GitHub Actions 构建 → 服务器直接拉取

`.github/workflows/docker-build.yml` 自动构建镜像并推送到 **GHCR**（`ghcr.io/<owner>/<repo>`，无需任何 Secrets）。服务器上无需构建：

```bash
./scripts/deploy.sh                              # 拉取镜像 → 迁移 → 启动 → /health 自检
./scripts/deploy-docker.sh                       # 纯 docker 命令版（无需 compose 插件）
```

> GHCR 镜像可见性与仓库一致：**仓库公开 → 镜像公开，服务器直接 `docker pull`，无需登录**。
> 镜像标签：分支名 / `v*` 版本标签 / `sha` / 默认分支附加 `latest`。

---

## 升级 / 迁移 / 回滚 / 备份

```bash
# 升级（宿主机 git 检出部署：管理面板「系统更新」一键更新，失败自动回滚）
git fetch --tags && git checkout <新版本> && docker compose up -d --build
# 容器化部署升级：推荐直接点管理面板「系统更新 → 一键更新」（面板热更新，免登录服务器）
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

管理端「🔄 系统更新」页：手动**一键检测** GitHub 最新 Release + 检测源保存 + **一键在线更新**（容器部署走面板热更新：拉新镜像自动重建容器、失败自动回滚；宿主机 git 部署走 git 拉取→构建→迁移→切换→自检→回滚）+ **客户端插件版本推送**（版本号 + 安装地址，支持 `github:owner/repo` / `npm:包名` / 直链 tgz 三种写法，页面内附示例）。

> ⚠️ 面板热更新依赖把宿主 docker socket 挂进 api 容器（`deploy-remote.sh` / `deploy-docker.sh` 默认挂载）。
> 含义：拿到管理端口令即具备操作宿主机 docker 的能力，请务必保管好管理员密码；如不需要面板热更新，删除脚本中
> `-v /var/run/docker.sock:/var/run/docker.sock` 两行后重跑即可（此时面板会提示在宿主机执行更新命令）。

---

## 目录结构

```
dsh-store-server/
├── src/
│   ├── shared/           # 跨端契约（协议/模型/API/配置）单一事实来源
│   ├── repo/             # 仓库：MemoryRepo（内存） / PgRepo（PostgreSQL 写穿）
│   ├── routes.ts         # REST 路由（公开 / 登录 / 联邦 / 管理端 / 管理面板）
│   ├── auth.ts           # GitHub OAuth + JWT（凭据缺失时休眠）
│   ├── sync/github.ts    # GitHub 同步管线（Search API 搜索 + 提取 + 星数快照 + 趋势榜）
│   ├── sync/federation.ts# 联邦互联（握手/共享/心跳/解约）
│   ├── security/         # 安全扫描管线 + 限流守卫（读/写/认证分档，429+告警）
│   ├── clock.ts          # 时钟漂移自检（>500ms 告警，>5s 拒签凭证）
│   ├── config.ts         # 配置加载（环境变量覆盖 shared 默认值）
│   ├── db/               # PostgreSQL 连接池 + 迁移运行器
│   └── index.ts          # 启动入口（仓库选择 / 同步调度 / 时钟自检）
├── admin/index.html      # 管理端面板（服务端托管于 /admin，接 admin API）
├── db/migrations/        # 迁移脚本（001~014 随版本递增）
├── scripts/update.sh     # 一键更新预置流水线（面板热更新 / 宿主机双模式）
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

---

## 与客户端插件联动的安装规范

商城收录的每个插件都提取「安装 spec」（`install` 字段），与 dsh 真实插件管理机制一致：

| 动作 | 命令 | 说明 |
|---|---|---|
| 安装 | `dsh plugin --profile <name> add <install>` | 转发给 pnpm add；`install` 为 npm 包名（如 `dsh-memory`）或 git spec（如 `github:owner/repo`，未发布到 npm 时）；可锁版本 `add <install>@<version>` |
| 卸载 | `dsh plugin --profile <name> remove <pkg>` | 转发给 pnpm remove，自动从组合层移除 |
| 入组合层 | 自动 | 插件 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 即被加入 profile 的配置层栈 |

提取管线：仓库 `package.json` 的 `name` → npm 注册表校验（`registry.npmjs.org/<name>/latest` 取最新版本）→ 未发布则回落 `github:owner/repo`。

---

## GitHub 标签（Topics）

DSH 插件商店的服务端按 GitHub topic 收录插件仓库，请给**插件仓库**（如 dsh-storecloud）打上：

| Topic | 作用 |
|---|---|
| **`dsh-plugin`** | **必打**：本服务端按此 topic 搜索并收录插件 |

本仓库（服务端）建议同时打：`dsh-store`、`dsh`、`plugin-marketplace`、`deepseek`。

> 打上 `dsh-plugin` topic 的插件仓库，会在本服务端下一次同步时被自动收录（需在配置中心配置 GitHub 搜索 token）。

---

## 许可

本项目采用 **CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享）** 开源协议：

- ✅ 可自由使用、修改、分发，但**禁止商业化使用**；
- 📝 使用须署名；衍生作品须以相同协议共享；
- 🔗 完整法律文本：<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>

---

## 工作区约定

- 依赖（`node_modules`）与 npm 缓存（`.npm-cache/`）全部落在工作区内，不写入用户目录、不安装全局包、不修改系统环境。
- 本机验证仅用 `npm install / build / typecheck / dev`；Docker 镜像构建与容器启动属部署阶段，不在本机执行。
