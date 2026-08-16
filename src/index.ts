import Fastify from 'fastify'
import compress from '@fastify/compress'
import { readFileSync, rmSync } from 'node:fs'
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
import { FedSync } from './sync/federation.js'
import { AlertService, installGuards, type RuntimeState } from './security/guard.js'
import { UpdateService, deployedVersionTag, normVersionTag } from './update.js'
import { checkClockDrift } from './clock.js'

const config = loadConfig(process.env)

const auth = new AuthService(process.env)
const sync = new GithubSync(process.env)
const alerts = new AlertService(config.alert.webhook)
const runtime: RuntimeState = { clockDriftMs: 0, rateLimited: 0, authFailures: 0, blockedRequests: 0, apiRequests: 0, apiErrors: 0, latestRelease: null, latestCommit: null, scanProgress: null }

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
// SYNC_MAX_REPOS 环境变量优先于仓库配置：本地测试可设 100，生产不设时保持默认 0 = 全量。
if (process.env.SYNC_MAX_REPOS !== undefined && process.env.SYNC_MAX_REPOS.trim() !== '') {
  boot.sync.max_repos = config.sync.max_repos
}
if (!boot.auth.github_client_id) boot.auth.github_client_id = process.env.GITHUB_OAUTH_CLIENT_ID ?? ''
if (!boot.auth.github_client_secret) boot.auth.github_client_secret = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? ''
if (!boot.auth.jwt_secret) boot.auth.jwt_secret = process.env.JWT_SECRET ?? ''
// 管理员口令：环境变量兜底；仅纯离线演示模式（无 OAuth 且无 GitHub token）给演示默认值。
// 生产环境两者皆空时管理端整体拒绝访问（503），不存在硬编码后门口令。
if (!boot.admin.password) boot.admin.password = process.env.ADMIN_TOKEN ?? (demo ? 'mock-admin' : '')
if (!boot.user.registration_methods.length) boot.user.registration_methods = ['github']
repo.setConfig(boot)
// ⚠ 对齐配置引用：registerRoutes 闭包读取的 cfg 必须与仓库持久化配置一致,
// 否则配置中心保存的值(如插件组审核开关)在进程重启后会回落到环境快照而失效。
// 这里以仓库配置为准覆盖 env 快照;后续管理端保存由 PUT /admin/config 的 Object.assign 继续同步。
Object.assign(config, repo.getConfig())

/**
 * 容器热更新完成后，新容器启动时读取编排容器写入的结果标记，
 * 把上一进程遗留的 running 状态收口为 done/failed —— 否则面板进度会永久卡在 55%。
 */
const finalizePanelUpdateState = (): void => {
  const active = new Set(['fetching', 'building', 'migrating', 'switching', 'selfcheck'])
  const state = repo.getUpdateState()
  if (!active.has(state.stage)) return
  try {
    const marker = '/opt/dsh-store/api.update-result'
    const text = readFileSync(marker, 'utf8').trim()
    rmSync(marker, { force: true })
    if (!text) return
    const [status, image] = text.split(/\s+/)
    const finishedAt = new Date().toISOString()
    if (status === 'OK') {
      repo.setUpdateState({
        ...state,
        stage: 'done',
        progress_pct: 100,
        message: `容器热更新完成：${image ?? state.to_version}`,
        error: null,
        finished_at: finishedAt,
        log: [...state.log, `panel-update: ${text}`],
      })
    } else if (status === 'FAIL') {
      repo.setUpdateState({
        ...state,
        stage: 'failed',
        progress_pct: 100,
        message: `容器热更新失败并已回滚：${image ?? state.to_version}`,
        error: text,
        finished_at: finishedAt,
        log: [...state.log, `panel-update: ${text}`],
      })
    }
  } catch {
    /* 没有结果标记（旧版本更新脚本/异常中断）：用当前镜像 tag 推断上次结果，避免进度永久卡住 */
    try {
      const currentImage = readFileSync('/opt/dsh-store/api.current-image', 'utf8').trim()
      const tag = currentImage.match(/:([^:/]+)$/)?.[1] ?? ''
      const finishedAt = new Date().toISOString()
      if (tag && state.to_version && (tag === state.to_version || tag.startsWith(state.to_version))) {
        repo.setUpdateState({
          ...state,
          stage: 'done',
          progress_pct: 100,
          message: `容器热更新完成（按当前镜像推断）：${currentImage}`,
          error: null,
          finished_at: finishedAt,
          log: [...state.log, `panel-update: current-image=${currentImage}`],
        })
      } else {
        repo.setUpdateState({
          ...state,
          stage: 'failed',
          progress_pct: 100,
          message: '上次容器热更新被中断，结果无法确认；请按当前镜像状态手动确认',
          error: `缺少更新结果标记，当前镜像=${currentImage || 'unknown'}`,
          finished_at: finishedAt,
          log: [...state.log, 'panel-update: missing result marker'],
        })
      }
    } catch {
      /* 非容器部署 */
    }
  }
}
finalizePanelUpdateState()

sync.setTokens(boot.sync.github_tokens)
sync.setMaxRepos(boot.sync.max_repos)
auth.configure({ clientId: boot.auth.github_client_id, clientSecret: boot.auth.github_client_secret, jwtSecret: boot.auth.jwt_secret })

const app = Fastify({
  logger: true,
  // 生产级安全（v3 §10）：限制 JSON 体积防滥用
  bodyLimit: 1_048_576,
})

// 全局响应压缩（gzip/deflate/brotli 自动协商，≥1KB 才压）：
// 插件库全量可达 2.7MB，压缩后 ~10% 体积，首次同步/增量拉取显著提速。
// SSE 事件流在路由级排除（见 routes.ts events 路由 compress: false）。
await app.register(compress, {
  global: true,
  threshold: 1024,
})

const updater = new UpdateService(repo)

app.addHook('onClose', async () => {
  await closeDb()
})

// 防护守卫：读/写/认证按 IP 限流（429 + 告警）
installGuards(app, alerts, runtime)

// GitHub 收录同步调度（仅定时触发）：
// - 启动不立即同步；每轮按配置间隔 github_fetch_interval_h（最低 1 小时）定时执行；
// - 管理端 POST /admin/sync 手动触发，不受此调度器影响；
// - 配置中心保存搜索 token 发生变化时调用 resetSyncSchedule() 重置倒计时（只重置、不立即同步）。
let syncTimer: NodeJS.Timeout | null = null
const scheduleSync = (): void => {
  if (syncTimer) clearTimeout(syncTimer)
  const hours = Math.max(1, repo.getConfig().sync.github_fetch_interval_h)
  syncTimer = setTimeout(() => {
    syncTimer = null
    void (async () => {
      if (sync.enabled && !sync.isRunning()) {
        await sync.runSync(repo.syncTarget())
        await repo.persistSync()
      }
    })().finally(() => {
      // 记录完成时刻：联邦同步调度据此错开(30 分钟冷却,避免撞车)
      lastGhSyncDoneAt = Date.now()
      scheduleSync()
    })
  }, hours * 3600_000)
}
const resetSyncSchedule = (): void => scheduleSync()
scheduleSync()

// 联邦数据同步调度（默认 24h 一轮,配置 federation.sync_interval_h 可调）：
// 遍历全部已连接(connected)联邦关系,按各自选择的类别拉取对端快照。
// ⚠ 预案：避开与 GitHub 收录同步、插件安全扫描撞车(都可能是小时级任务)——
//   执行前检查：安全扫描进行中、或距上次 GitHub 同步完成不足 30 分钟 → 推迟 30 分钟重试。
const fedSync = new FedSync(repo, () => repo.getConfig())
let fedTimer: NodeJS.Timeout | null = null
let fedFirstRound = true
let lastGhSyncDoneAt = 0
const COOLDOWN_MS = 30 * 60_000
const runFedSyncOnce = async (): Promise<void> => {
  try {
    const results = await fedSync.runOnce()
    for (const r of results) {
      if (!r.ok) void alerts.send('联邦同步失败', `${r.peer}：${r.error ?? '未知错误'}`)
    }
  } catch (e) {
    console.error('[fed] 联邦同步异常:', e instanceof Error ? e.message : e)
  } finally {
    fedFirstRound = false
    scheduleFedSync()
  }
}
const scheduleFedSync = (): void => {
  if (fedTimer) clearTimeout(fedTimer)
  // 首轮不干等整个间隔：启动 10 分钟后执行一次(避开启动高峰期),之后按配置间隔。
  const delay = fedFirstRound ? 10 * 60_000 : Math.max(1, repo.getConfig().federation.sync_interval_h) * 3600_000
  fedTimer = setTimeout(() => {
    fedTimer = null
    const scanning = runtime.scanProgress?.running ?? false
    const tooSoonAfterGh = Date.now() - lastGhSyncDoneAt < COOLDOWN_MS
    if (scanning || tooSoonAfterGh) {
      // 撞车预案：推迟 30 分钟再试；到点后复查条件(仍冲突则继续推迟),避免与扫描/GitHub 同步争抢。
      console.log(`[fed] 检测到${scanning ? '安全扫描进行中' : 'GitHub 同步刚结束'}，联邦同步推迟 30 分钟`)
      fedTimer = setTimeout(() => { fedTimer = null; void runFedSyncOnce() }, COOLDOWN_MS)
      return
    }
    void runFedSyncOnce()
  }, delay)
}
scheduleFedSync()

// 组合软删宽限清理（管理员删除后 3 天未恢复 → 作废删除 + 私人公告通知作者）：
// 每 6 小时检查一次(与联邦同步同预案,避开扫描/GitHub 同步),宽限 72 小时。
const COMBO_GRACE_H = 72
setInterval(() => {
  if (runtime.scanProgress?.running) return
  try {
    const expired = repo.purgeExpiredCombos(COMBO_GRACE_H)
    for (const e of expired) {
      repo.addAnnouncement({
        version: '*',
        level: 'important',
        content: `你的组合「${e.name}」被管理员删除后 3 天内未恢复，现已作废删除。若仍需发布请重新创建。`,
        user_id: e.author,
      })
      console.log(`[combos] 宽限到期作废删除: ${e.name} (作者 ${e.author})`)
    }
  } catch (e) {
    console.error('[combos] 宽限清理异常:', e instanceof Error ? e.message : e)
  }
}, 6 * 3600_000)

await registerRoutes(app, repo, config, auth, sync, fedSync, alerts, runtime, updater, resetSyncSchedule)

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
