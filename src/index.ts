import Fastify from 'fastify'
import { loadEnvFile } from './env.js'
import { SOFTWARE_NAME } from './shared/index.js'

loadEnvFile()

import { loadConfig } from './config.js'
import { MemoryRepo } from './repo/memory.js'
import { PgRepo } from './repo/pg.js'
import type { Repo } from './repo/types.js'
import { getPool, closeDb, dbEnabled } from './db/pool.js'
import { registerRoutes } from './routes.js'
import { AuthService } from './auth.js'
import { GithubSync } from './sync/github.js'
import { AlertService, installGuards, type RuntimeState } from './security/guard.js'
import { UpdateService, deployedVersionTag, normVersionTag } from './update.js'
import { checkClockDrift } from './clock.js'

const config = loadConfig(process.env)

const auth = new AuthService(process.env)
const sync = new GithubSync(process.env)
const alerts = new AlertService(config.alert.webhook)
const runtime: RuntimeState = { clockDriftMs: 0, rateLimited: 0, authFailures: 0, blockedRequests: 0, apiRequests: 0, apiErrors: 0, latestRelease: null, latestCommit: null }

// 仓库选择：DATABASE_URL 就绪 → PostgreSQL（启动加载 + 写穿）；否则内存仓库。
// 演示假数据仅注入「纯内存且纯离线」模式（无数据库、无 GitHub token、未配置 OAuth）：
// 只要挂了数据库就是正式数据面，刚部署的空库保持为空，直到配置 GITHUB_TOKENS 同步后才有插件。
const demo = !dbEnabled() && !sync.enabled && !auth.enabled
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// 数据库启动窗口重试：容器编排里 db 可能晚于 api 就绪（DNS 未生效等），避免裸崩溃循环
async function createRepoWithRetry(factory: () => Promise<Repo>, attempts = 8, delayMs = 3000): Promise<Repo> {
  let lastErr: unknown = null
  for (let i = 1; i <= attempts; i++) {
    try {
      return await factory()
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[db] 数据库连接失败（第 ${i}/${attempts} 次）：${msg}`)
      if (i < attempts) await sleep(delayMs)
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  console.error(
    `[db] 数据库连接失败（已重试 ${attempts} 次）：${msg}\n` +
      '排查：\n' +
      '  1. api 与数据库容器必须处于同一 docker 网络：./scripts/deploy-docker.sh 已自动处理；\n' +
      '     手工 docker run 时 api 与 db 都必须加 --network dshstore-net；\n' +
      '  2. DATABASE_URL 的 host 必须是该网络内的数据库容器名（dshstore-db，脚本同时注册了别名 db）；\n' +
      '  3. 确认数据库容器已就绪：docker ps | grep dshstore-db 与 docker logs dshstore-db。',
  )
  process.exit(1)
}

const repo: Repo = dbEnabled() ? await createRepoWithRetry(() => PgRepo.create(getPool(), demo)) : new MemoryRepo(demo)

// 配置中心优先、部署环境变量兜底：密钥已从"部署时填写"迁移到"配置中心填写"，
// 环境变量仅作首启默认值；管理端保存即热更新（routes PUT /admin/config）。
const boot = repo.getConfig()
if (boot.sync.github_tokens.length === 0) {
  boot.sync.github_tokens = (process.env.GITHUB_TOKENS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
if (!boot.auth.github_client_id) boot.auth.github_client_id = process.env.GITHUB_OAUTH_CLIENT_ID ?? ''
if (!boot.auth.github_client_secret) boot.auth.github_client_secret = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? ''
if (!boot.auth.jwt_secret) boot.auth.jwt_secret = process.env.JWT_SECRET ?? ''
// 管理员口令：环境变量兜底；仅纯离线演示模式（无 OAuth 且无 GitHub token）给演示默认值。
// 生产环境两者皆空时管理端整体拒绝访问（503），不存在硬编码后门口令。
if (!boot.admin.password) boot.admin.password = process.env.ADMIN_TOKEN ?? (demo ? 'mock-admin' : '')
if (!boot.user.registration_methods.length) boot.user.registration_methods = ['github']
repo.setConfig(boot)

sync.setTokens(boot.sync.github_tokens)
auth.configure({ clientId: boot.auth.github_client_id, clientSecret: boot.auth.github_client_secret, jwtSecret: boot.auth.jwt_secret })

const app = Fastify({
  logger: true,
  // 生产级安全（v3 §10）：限制 JSON 体积防滥用
  bodyLimit: 1_048_576,
})

const updater = new UpdateService(repo)

app.addHook('onClose', async () => {
  await closeDb()
})

// 防护守卫：读/写/认证按 IP 限流（429 + 告警）
installGuards(app, alerts, runtime)

await registerRoutes(app, repo, config, auth, sync, alerts, runtime, updater)

// 时钟自检（v3.6 U5）：启动 + 每小时；>500ms 告警，>5s 拒签凭证（/auth/callback）
const runClockCheck = async () => {
  const drift = await checkClockDrift()
  runtime.clockDriftMs = drift
  if (Math.abs(drift) > 5000) void alerts.send('时钟漂移严重', `当前漂移 ${drift}ms，已拒绝签发时间敏感凭证`)
  else if (Math.abs(drift) > 500) void alerts.send('时钟漂移', `当前漂移 ${drift}ms，请检查宿主机 NTP`)
}
void runClockCheck()
setInterval(() => void runClockCheck(), 3600_000)

// 模式提示
if (!sync.enabled && !auth.enabled) {
  app.log.warn('纯离线演示模式：注入演示假数据，管理员演示凭证为 mock-admin（生产环境请配置 ADMIN_TOKEN / OAuth）')
} else if (!repo.getConfig().admin.password) {
  app.log.warn('管理员口令未配置：设置环境变量 ADMIN_TOKEN 或在管理端配置中心保存管理密码，此前管理端不可用')
} else {
  app.log.warn('注意：管理口令强度不足会削弱安全；建议使用强随机值（可通过 ADMIN_TOKEN 或配置中心设置）')
}

// GitHub 同步调度：常驻自检——配置中心保存 token 后无需重启即可同步（每轮读最新配置）
const scheduleSync = (): void => {
  void (async () => {
    if (sync.enabled) {
      void sync.runSync(repo.syncTarget()).then(() => repo.persistSync())
    }
  })().finally(() => {
    const hours = Math.max(1, repo.getConfig().sync.github_fetch_interval_h)
    setTimeout(scheduleSync, hours * 3600_000)
  })
}
scheduleSync()

// 本项目更新提醒（v3.7 V1）：按配置间隔检测，只提醒不自动更。
// 跟踪通道（release / commit）与仓库地址、间隔在配置中心修改后下一轮检测即生效（每轮动态读取配置）。
const scheduleReleaseCheck = (): void => {
  void (async () => {
    const live = repo.getConfig()
    const repoUrl = live.update.repo_url
    if (!repoUrl) return
    if (live.update.track === 'commit') {
      runtime.latestCommit = await sync.checkLatestCommit(repoUrl)
    } else {
      const latest = await sync.checkLatestRelease(repoUrl)
      runtime.latestRelease = latest
      const current = deployedVersionTag()
      if (latest?.tag && normVersionTag(latest.tag) !== normVersionTag(current)) {
        void alerts.send('发现新版本', `本项目最新 Release：${normVersionTag(latest.tag)}（${latest.published_at ?? '—'}）`)
      }
    }
  })().finally(() => {
    const mins = Math.max(5, repo.getConfig().update.check_interval_min)
    setTimeout(scheduleReleaseCheck, mins * 60_000)
  })
}
scheduleReleaseCheck()

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '0.0.0.0'

try {
  await app.listen({ port, host })
  app.log.info(`${SOFTWARE_NAME} 服务端已启动: http://${host}:${port}（仓库：${dbEnabled() ? 'PostgreSQL' : '内存'})`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
