import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readFile } from 'node:fs/promises'
import { existsSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API,
  PROTOCOL_VERSION,
  SOFTWARE_NAME,
  type Announcement,
  type Combo,
  type Delta,
  type Manifest,
  type Plugin,
} from './shared/index.js'
import type { ServerConfig } from './shared/config.js'
import type { Repo } from './repo/types.js'
import { pingDb } from './db/pool.js'
import type { AuthService } from './auth.js'
import type { GithubSync } from './sync/github.js'
import { FedSync, FED_KINDS, type FedSyncKind } from './sync/federation.js'
import { scanPlugin } from './security/scan.js'
import type { AlertService, RuntimeState } from './security/guard.js'
import type { UpdateService } from './update.js'
import { serverVersion, deployedVersionTag, normVersionTag } from './update.js'
import { Broadcast } from './broadcast.js'

interface AuthUser {
  userId: string
  login: string
}

/**
 * 路由注册。仓库面向 Repo 接口：无凭据阶段用 MemoryRepo，DATABASE_URL 就绪后换 PgRepo。
 * 认证：配置 OAuth 凭据后为真实 GitHub OAuth JWT；仅纯离线演示模式（无 OAuth 且无 GitHub token）
 * 接受演示账号 mock-liwei / mock-xiaoyu，管理端口令 = ADMIN_TOKEN / 配置中心密码（演示默认 mock-admin）。
 */
export async function registerRoutes(
  app: FastifyInstance,
  repo: Repo,
  cfg: ServerConfig,
  auth: AuthService,
  sync: GithubSync,
  fedSync: FedSync,
  alerts: AlertService,
  runtime: RuntimeState,
  updater: UpdateService,
  resetSyncSchedule: () => void,
): Promise<void> {
  // 纯离线演示模式：未配置 OAuth 且未配置 GitHub token 时才接受演示账号（生产不残留后门）
  const demoMode = !auth.enabled && !sync.enabled
  // SSE 广播器：点赞/公告/插件库变更实时推送（单实例；多实例预留 Redis pub/sub）。
  const broadcast = new Broadcast()
  const currentUser = (req: FastifyRequest): AuthUser | null => {
    const authHeader = req.headers.authorization
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const real = auth.verify(token)
      if (real) {
        // 懒注册兜底：修复前已持有有效 JWT 的用户（未走 /auth/callback）首次请求时补录，
        // 管理端用户管理页才能看到全部真实用户。幂等：已存在则不产生任何写。
        // 封禁/注销即时生效：status !== active 拒绝访问（JWT 本身不吊销,靠状态位拦截）。
        const u = repo.registerUser({ login: real.login, name: real.name, githubId: real.githubId, homeServer: homeOf(req) })
        if (u.status !== 'active') return null
        return { userId: `u_${real.login}`, login: real.login }
      }
      if (demoMode) {
        if (token === 'mock-liwei') return { userId: 'u_liwei', login: 'liwei' }
        if (token === 'mock-xiaoyu') return { userId: 'u_xiaoyu', login: 'xiaoyu' }
      }
    }
    return null
  }
  /** 当前请求的 host（用户 home_server 归属；OAUTH_CALLBACK_URL 显式配置时优先）。 */
  const homeOf = (req: FastifyRequest): string => {
    const base = process.env.OAUTH_CALLBACK_URL ?? `${req.protocol}://${req.headers.host ?? ''}`
    return base.replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'unknown'
  }
  const requireUser = (req: FastifyRequest, reply: FastifyReply): AuthUser | null => {
    const u = currentUser(req)
    if (!u) {
      runtime.authFailures++
      void alerts.send('登录失败', `未授权访问被拒：${req.method} ${req.url}（IP ${req.ip ?? 'unknown'}）`)
      void reply.code(401).send({ error: 'unauthorized', message: '需要 GitHub 登录' })
      return null
    }
    return u
  }
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    // 管理员口令：配置中心优先 → 环境变量 ADMIN_TOKEN 兜底；两者皆空 → 管理端不可用（503），无硬编码默认口令
    const expected = repo.getConfig().admin.password || process.env.ADMIN_TOKEN || ''
    if (!expected) {
      void reply.code(503).send({ error: 'not_configured', message: '管理员口令未配置：刷新管理页即可进入「首次使用 · 设置密码」流程' })
      return false
    }
    if (req.headers['x-admin-token'] !== expected) {
      runtime.authFailures++
      void alerts.send('管理端失败', `管理端凭证错误：${req.method} ${req.url}（IP ${req.ip ?? 'unknown'}）`)
      void reply.code(401).send({ error: 'unauthorized', message: '需要管理员凭证' })
      return false
    }
    return true
  }

  // 源服务器连接密码（server.access_password，配置中心保存后热更新）：
  // 非空时，客户端数据通道（/api/v1/* 与 /health）必须携带 X-Access-Password；
  // /auth/*（OAuth 浏览器流程）、/admin/*（管理端自鉴权）与 /federation/*（联邦密码）不受此限制。
  app.addHook('onRequest', async (req, reply) => {
    const expected = repo.getConfig().server.access_password
    if (!expected) return
    const path = req.url.split('?')[0]
    const isClientData = path === '/health' || (path.startsWith('/api/v1/') && !path.startsWith('/api/v1/federation/'))
    if (!isClientData) return
    if (req.headers['x-access-password'] !== expected) {
      runtime.blockedRequests++
      void alerts.send('源连接密码拒绝', `源连接密码缺失或错误：${req.method} ${req.url}（IP ${req.ip ?? 'unknown'}）`)
      void reply.code(401).send({ error: 'access_password_required', message: '服务器连接密码缺失或不正确（请求头 X-Access-Password）' })
    }
  })

  // 联邦密码（federation.secret）：服务器间接口只认 X-Federation-Secret，不要求管理端口令。
  const requireFederation = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const fed = repo.getConfig().federation
    if (!fed.enabled) {
      void reply.code(503).send({ error: 'federation_disabled', message: '本服务器未开启联邦（管理端配置中心可开启）' })
      return false
    }
    if (!fed.secret) {
      void reply.code(503).send({ error: 'not_configured', message: '本服务器未配置联邦密码（管理端配置中心可设置）' })
      return false
    }
    if (req.headers['x-federation-secret'] !== fed.secret) {
      runtime.blockedRequests++
      void alerts.send('联邦密码拒绝', `联邦密码缺失或错误：${req.method} ${req.url}（IP ${req.ip ?? 'unknown'}）`)
      void reply.code(401).send({ error: 'federation_secret_required', message: '联邦密码缺失或不正确（请求头 X-Federation-Secret）' })
      return false
    }
    return true
  }

  /* ================= 根路径 → 管理端 ================= */
  app.get('/', async (_req, reply) => reply.redirect('/admin'))

  /* ================= 管理端面板（静态页面） ================= */
  const adminHtml = async (_req: FastifyRequest, reply: FastifyReply) => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../admin/index.html')
    return reply.type('text/html; charset=utf-8').send(await readFile(file, 'utf8'))
  }
  app.get('/admin', adminHtml)
  app.get('/admin/', adminHtml)

  /* ================= 首次使用：设置管理员密码（口令未配置时开放，先到先得） ================= */
  app.get('/admin/setup/status', async () => ({
    needs_setup: !(repo.getConfig().admin.password || process.env.ADMIN_TOKEN || ''),
  }))
  app.post<{ Body: { password: string } }>('/admin/setup', async (req, reply) => {
    if (repo.getConfig().admin.password || process.env.ADMIN_TOKEN) {
      return reply.code(409).send({ error: 'already_configured', message: '管理员口令已配置（如需修改请登录后在配置中心「管理员」项修改）' })
    }
    const password = req.body?.password
    if (typeof password !== 'string' || password.length < 8) {
      return reply.code(400).send({ error: 'bad_request', message: '密码至少 8 位' })
    }
    const next: ServerConfig = { ...repo.getConfig(), admin: { ...repo.getConfig().admin, password } }
    repo.setConfig(next)
    Object.assign(cfg, next)
    repo.log('admin', 'setup.password', {})
    return { ok: true }
  })

  /* ================= GitHub OAuth（未配置凭据时 503 休眠） ================= */
  app.get<{ Querystring: { redirect?: string } }>('/auth/login', async (_req, reply) => {
    const regCfg = repo.getConfig()
    if (!regCfg.user.registration_enabled) {
      return reply.code(503).send({ error: 'registration_closed', message: '注册已关闭（管理端配置中心可开启）' })
    }
    if (!regCfg.user.registration_methods.includes('github')) {
      return reply.code(503).send({ error: 'registration_closed', message: '当前未开放 GitHub 账号注册' })
    }
    if (!auth.enabled) {
      return reply.code(503).send({ error: 'not_configured', message: '未配置 GitHub OAuth 凭据（Client ID/Secret/JWT 密钥），可在管理端配置中心填写' })
    }
    // 回调地址必须与 GitHub OAuth App 注册的 callback URL 完全一致：
    // 优先 OAUTH_CALLBACK_URL 显式配置；否则固定使用官方域名(用户登记的
    // 回调地址为 https://blog.1qwq1.top/auth/callback)。
    // ⚠ 不能依赖 req.protocol / req.headers.host：反代内部转发时两者都可能
    // 与 GitHub 登记的地址不一致 → "The redirect_uri is not associated"。
    const base = process.env.OAUTH_CALLBACK_URL ?? 'https://blog.1qwq1.top'
    const state = auth.newState()
    return reply.redirect(auth.authorizeUrl(`${base}/auth/callback`, state))
  })
  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/callback', async (req, reply) => {
    const regCfg = repo.getConfig()
    if (!regCfg.user.registration_enabled || !regCfg.user.registration_methods.includes('github')) {
      return reply.code(503).send({ error: 'registration_closed', message: '注册已关闭' })
    }
    if (!auth.enabled) return reply.code(503).send({ error: 'not_configured', message: 'OAuth 未配置' })
    if (Math.abs(runtime.clockDriftMs) > 5000) {
      return reply.code(503).send({ error: 'clock_drift', message: '服务器时钟漂移过大，已拒绝签发凭证' })
    }
    const { code, state } = req.query
    if (!code || !state || !auth.consumeState(state)) {
      return reply.code(400).send({ error: 'bad_request', message: 'state 无效' })
    }
    const user = await auth.exchange(code)
    if (!user) return reply.code(401).send({ error: 'unauthorized', message: 'GitHub 授权失败' })
    // 注册/更新用户（幂等）：OAuth 登录即落库，管理端用户管理页由此获得真实用户列表。
    // 注册时间只记首次（已存在用户仅刷新资料，不改 registered_at）。
    repo.registerUser({ login: user.login, name: user.name, githubId: user.githubId, homeServer: homeOf(req) })
    repo.log('auth', 'register', { login: user.login, github_id: user.githubId })
    const token = auth.issueToken(user)
    // 授权完成页：自动把 token postMessage 回传给 opener(客户端商城窗口)，无需手动复制粘贴。
    // 兜底：opener 不可用(用户直接访问本页)时页面展示 token 文本供手动复制。
    const esc = (s: unknown): string => JSON.stringify(String(s ?? ''))
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>GitHub 授权完成</title></head>
<body style="margin:0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:24px">
<div style="font-size:44px">✅</div>
<h2 style="margin:10px 0 6px">GitHub 授权成功</h2>
<p style="color:#8b98a5;margin:0 0 14px">正在自动传回 DSH 商城…请返回商城面板</p>
<details style="font-size:12px;color:#5b6675;text-align:left;margin:0 auto;max-width:520px">
<summary>手动复制 token(自动回传失败时)</summary>
<pre style="white-space:pre-wrap;word-break:break-all;background:#161b22;border:1px solid #2b3340;border-radius:8px;padding:10px">${esc(token)}</pre>
</details>
</div>
<script>
(function () {
  var payload = { type: 'dsh-store-auth', token: ${esc(token)}, login: ${esc(user.login)}, name: ${esc(user.name ?? null)} }
  // 双发：页面加载即发一次，250ms 后再补一次，避免 opener 侧监听器尚未就绪的时序问题。
  try { if (window.opener) { window.opener.postMessage(payload, '*') } } catch (e) {}
  setTimeout(function () {
    try { if (window.opener) { window.opener.postMessage(payload, '*') } } catch (e) {}
  }, 250)
  setTimeout(function () { try { window.close() } catch (e) {} }, 1200)
})();
</script>
</body></html>`
    reply.type('text/html; charset=utf-8')
    return reply.send(html)
  })

  /* ================= 健康 ================= */
  app.get('/health', async () => ({
    ok: true,
    software: SOFTWARE_NAME,
    protocol_version: PROTOCOL_VERSION,
    db: await pingDb(),
    time: new Date().toISOString(),
  }))

  /* ================= manifest ================= */
  app.get(API.manifest, async (): Promise<Manifest> => ({
    protocol_version: PROTOCOL_VERSION,
    software_version: serverVersion(),
    cluster_id: process.env.CLUSTER_ID ?? null,
    server_time: new Date().toISOString(),
    plugins_revision: String(repo.getPluginsRevision()),
    combos_revision: String(repo.getCombosRevision()),
    latest_announcement_id: repo.latestAnnouncementId(),
    features: {
      trending: cfg.feature.trending,
      likes: cfg.feature.likes,
      combos: cfg.feature.combos,
      announcements: cfg.feature.announcements,
      federation: cfg.federation.enabled,
    },
    nodes: repo.getNodes(),
    client_config: {
      trending_size: cfg.trending.size,
      search_threshold: 0.4,
      onboarding_auto_open_times: cfg.onboarding.auto_open_times,
      server_local_port: cfg.server.local_port,
      ui_default_theme: cfg.ui.default_theme,
      ui_window_min: cfg.ui.window_min,
      ui_window_max: cfg.ui.window_max,
      data_heartbeat_min: cfg.sync.data_heartbeat_min,
      combos_refresh_min: cfg.sync.combos_refresh_min,
      restore_max_points: cfg.restore.max_points,
      combo_limit: cfg.user.combo_limit,
      /** 插件组审核开关：true=发布需审核；false=发布直接上线。客户端弹窗提示用。 */
      combo_review_enabled: cfg.user.combo_review_enabled,
    },
    // 客户端插件版本推送：配置中心 client.plugin_version 非空即下发
    client_plugin: repo.getConfig().client.plugin_version
      ? { version: repo.getConfig().client.plugin_version, install: repo.getConfig().client.install_spec }
      : null,
  }))

  /* ================= 数据通道（增量 + 全量兜底） ================= */
  app.get<{ Querystring: { since?: string; kind?: string } }>(API.plugins, async (req): Promise<Delta<Plugin>> => {
    const delta = repo.pluginsDelta(req.query.since)
    const kind = req.query.kind
    if (kind === 'plugin') return { ...delta, items: delta.items.filter((p) => p.kind !== 'preset') }
    if (kind === 'agent' || kind === 'preset') return { ...delta, items: delta.items.filter((p) => p.kind === 'preset') }
    return delta
  })
  app.get<{ Querystring: { since?: string } }>(API.combos, async (req): Promise<Delta<Combo>> => {
    // 组合数据通道：注入订阅数(全站订阅该组的去重用户数,替代本站点赞)。
    // 组合更新不实时推送(省服务器资源),客户端按 data_heartbeat_min 周期拉取。
    const delta = repo.combosDelta(req.query.since)
    return { ...delta, items: delta.items.map((c) => ({ ...c, subscribers: repo.comboSubscribers(c.name) })) }
  })
  app.get(API.announcements, async (req): Promise<Announcement[]> => {
    // 私人公告（user_id 非空）仅对目标用户可见；匿名/未登录只看全站公告。
    const me = currentUser(req)
    return repo.getAnnouncements().filter((a) => !a.user_id || (me !== null && a.user_id === me.login))
  })
  app.get(API.nodes, async () => repo.getNodes())
  app.get(API.clusterNodes, async () => repo.getNodes())

  /* ================= SSE 实时事件流 =================
   * 广播型数据推送（点赞数/公告/插件库变更）：EventSource 直连，跨源需 CORS 头。
   * 事件格式：event: <type>\ndata: <json>\n\n；30s 心跳注释保活。
   */
  app.get(API.events, async (_req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })
    raw.write(`event: connected\ndata: {"hello":true}\n\n`)
    const unsubscribe = broadcast.subscribe(reply)
    const heartbeat = setInterval(() => {
      try {
        raw.write(': ping\n\n')
      } catch {
        /* 连接已断，交由 close 事件清理 */
      }
    }, 30000)
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  /* ================= 匿名会话凭证 ================= */
  app.post<{ Body: { instance_id?: string } }>(API.anonToken, async (req) => {
    const token = repo.mintAnonToken(req.body?.instance_id ?? 'anon')
    return { token, expires_at: new Date(Date.now() + cfg.anon.token_ttl * 1000).toISOString() }
  })

  /* ================= 安装/下载计数（匿名写：凭证门槛 + 1h 窗口去重） ================= */
  app.post<{ Body: { target: string } }>(API.downloads, async (req, reply) => {
    const token = req.headers['x-anon-token']
    if (typeof token !== 'string' || !repo.verifyAnonToken(token)) {
      runtime.blockedRequests++
      void alerts.send('匿名写拒绝', `无凭证下载计数被拒：${req.method} ${req.url}（IP ${req.ip ?? 'unknown'}）`)
      return reply.code(401).send({ error: 'anon_token_required', message: '需要匿名会话凭证：先 POST /api/v1/anon-token 获取' })
    }
    const target = req.body?.target
    if (typeof target !== 'string' || !target.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: 'target 必填' })
    }
    const res = repo.recordInstall(token, target.trim())
    if (!res.ok) return reply.code(404).send({ error: 'not_found', message: '目标插件/组合不存在' })
    return { target, counted: res.counted, downloads_7d: res.downloads_7d }
  })

  /* ================= 点赞（登录；疑似刷赞进风控队列） ================= */
  app.post<{ Body: { target: string; value?: 1 | -1 } }>(API.like, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const target = req.body?.target
    if (typeof target !== 'string' || !target.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: 'target 必填' })
    }
    const ip = req.ip ?? 'unknown'
    const reason = repo.checkLikeRisk(u.userId, u.login, target, ip)
    if (reason) {
      const item = repo.queueRiskLike({ userId: u.userId, login: u.login, target, ip, reason })
      repo.log(u.login, 'like.risk_pending', { target, reason, risk_id: item.id })
      void alerts.send('疑似刷赞', `账号 ${u.login} 对 ${target} 的点赞已隔离为待确认：${reason}`)
      return { target, status: 'pending', likes: repo.likeCount(target), liked: false, reason }
    }
    const res = repo.toggleLike(u.userId, target)
    repo.applyLikeCount(target, res.count)
    // 实时推送点赞变化(客户端据此本地更新计数,无需重拉)。
    broadcast.publish('likes', { target, likes: res.count, liked: res.liked })
    return { target, likes: res.count, liked: res.liked }
  })

  /* ================= 查询我的点赞（登录；客户端初始化已赞状态用） ================= */
  app.get(API.meLikes, async (req, reply): Promise<string[]> => {
    const u = requireUser(req, reply)
    if (!u) return []
    return repo.getUserLikes(u.userId)
  })

  /* ================= 创建组合（登录） ================= */
  app.post<{ Body: { name: string; description?: string; members?: Array<string | { pkg: string; install_mode?: 'auto' | 'manual' }> } }>(API.createCombo, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const name = req.body?.name
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) {
      return reply.code(400).send({ error: 'bad_request', message: '组合名称必填且 ≤30 字' })
    }
    if (repo.countUserCombos(u.login) >= cfg.user.combo_limit) {
      return reply.code(409).send({ error: 'limit', message: `每用户上限 ${cfg.user.combo_limit} 个组合` })
    }
    const combo = repo.createCombo({
      name: name.trim(),
      description: req.body?.description ?? '',
      members: req.body?.members ?? [],
      author: u.login,
      authorGithub: u.login,
    })
    // 审核开关：开 → pending 待审；关 → published 直接实时上线。
    // 已通过审核的组合编辑保存时保持 published(免审),由 updateCombo 保留状态实现。
    if (!cfg.user.combo_review_enabled && combo.status === 'pending') {
      repo.setComboStatus(combo.id, 'published')
      combo.status = 'published'
    }
    repo.log(u.login, 'combo.create', { id: combo.id, members: combo.members.length, status: combo.status })
    return combo
  })
  /* ================= 编辑组合（登录；仅作者本人） ================= */
  app.put<{ Params: { id: string }; Body: { name: string; description?: string; members?: Array<string | { pkg: string; install_mode?: 'auto' | 'manual' }> } }>(`${API.createCombo}/:id`, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const name = req.body?.name
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) {
      return reply.code(400).send({ error: 'bad_request', message: '组合名称必填且 ≤30 字' })
    }
    const c = repo.updateCombo(req.params.id, u.login, {
      name: name.trim(),
      description: req.body?.description ?? '',
      members: req.body?.members ?? [],
    })
    if (!c) return reply.code(404).send({ error: 'not_found', message: '组合不存在或不是你的组合' })
    repo.log(u.login, 'combo.update', { id: c.id, members: c.members.length })
    return c
  })
  app.delete<{ Params: { id: string } }>(`${API.createCombo}/:id`, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    if (!repo.removeCombo(req.params.id, u.login)) {
      return reply.code(404).send({ error: 'not_found', message: '组合不存在或不是你的组合' })
    }
    repo.log(u.login, 'combo.remove', { id: req.params.id })
    return { ok: true, combos: repo.getCombos() }
  })

  /* ================= 云端安装清单（登录） ================= */
  app.get(API.meInstalls, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    return repo.installsOf(u.userId)
  })
  app.put<{ Body: { installs: Array<{ target: string; type: 'plugin' | 'combo'; version: string }> } }>(API.meInstalls, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    return repo.replaceInstalls(u.userId, req.body?.installs ?? [])
  })

  /* ================= 注销账号（登录；联动服务器清理，v3.6 U2） ================= */
  app.post<{ Body: { combos?: 'delete' | 'anonymize' } }>(API.meDeactivate, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const choice = req.body?.combos === 'delete' ? 'delete' : 'anonymize'
    const r = repo.deactivateUser(u.userId, u.login, choice)
    repo.log(u.login, 'account.deactivated', { choice, ...r.deleted })
    return { ok: r.ok, deleted: r.deleted, message: '账号已注销：点赞与云端清单已删除，组合已' + (choice === 'delete' ? '删除' : '匿名保留') }
  })

  /* ================= 换源迁移（预检） ================= */
  app.post(API.meMigrate, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const conflicts: Array<{ kind: string; target: string; note: string }> = []
    for (const like of repo.getLikes()) {
      if (like.user_id === u.userId) conflicts.push({ kind: 'like', target: like.target, note: '该源已有你的点赞记录，将幂等合并' })
    }
    repo.log(u.login, 'migrate.precheck', { conflicts: conflicts.length })
    return { conflicts }
  })

  /* ================= 库外插件上报（登录） ================= */
  app.post<{ Body: { pkg: string; repo_url?: string | null; version?: string } }>(API.reportMissing, async (req, reply) => {
    const u = requireUser(req, reply)
    if (!u) return
    const pkg = req.body?.pkg
    if (typeof pkg !== 'string' || !pkg.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: '包名必填' })
    }
    const r = repo.addReport({ pkg: pkg.trim(), repo_url: req.body?.repo_url ?? null, version: req.body?.version ?? '' })
    repo.log(u.login, 'report.missing', { pkg })
    return { ok: true, report: r, message: `已收到上报：${pkg.trim()}，我们会持续跟进` }
  })

  /* ================= 联邦（服务器间） ================= */
  app.post<{ Body: { from_url: string; share?: Record<string, unknown>; mode?: 'snapshot' | 'realtime'; kinds?: string[] } }>(API.federationHandshake, async (req, reply) => {
    if (!requireFederation(req, reply)) return
    const fromUrl = req.body?.from_url
    if (typeof fromUrl !== 'string' || !fromUrl.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: '对方地址必填' })
    }
    const r = repo.addFedRelation({ peer_url: fromUrl.trim(), mode: req.body?.mode ?? 'snapshot' })
    // 对方选择的同步类别(缺省全部)存进关系 share,接受后按此同步
    const kinds = Array.isArray(req.body?.kinds) ? (req.body.kinds as string[]).filter((k) => FED_KINDS.includes(k as FedSyncKind)) : []
    if (kinds.length) repo.updateFedShare(r.id, { kinds: kinds.join(',') })
    repo.log('admin', 'federation.handshake', { peer: fromUrl, kinds })
    return { ok: true, message: '邀请已发送，等待对方接受', id: r.id }
  })
  /** 联邦数据同步导出：对端按类别拉取本服快照(需联邦密码)。 */
  app.get<{ Querystring: { kind?: string } }>('/api/v1/federation/sync', async (req, reply) => {
    if (!requireFederation(req, reply)) return
    const kind = req.query.kind
    if (!kind || !FED_KINDS.includes(kind as FedSyncKind)) {
      return reply.code(400).send({ error: 'bad_request', message: `kind 必填且 ∈ ${FED_KINDS.join('|')}` })
    }
    const self = (process.env.OAUTH_CALLBACK_URL ?? `${req.protocol}://${req.headers.host ?? ''}`).replace(/\/+$/, '')
    if (kind === 'plugins') {
      return { kind, server: self, items: repo.getPlugins() }
    }
    if (kind === 'agents') {
      return { kind, server: self, items: repo.getPlugins().filter((p) => p.kind === 'preset') }
    }
    if (kind === 'combos') {
      return { kind, server: self, items: repo.getCombos().filter((c) => c.status !== 'removed') }
    }
    // users：非敏感字段镜像 + 云端清单(只读,对端用于作者资料展示/统计)
    const users = repo.getUsers().map((u) => ({ id: u.id, github_id: u.github_id, login: u.login, name: u.name, home_server: u.home_server, status: u.status, registered_at: u.registered_at }))
    const installs = repo.installsOfAll()
    return { kind, server: self, items: { users, installs } }
  })
  app.get(API.federationChanges, async (req, reply) => {
    if (!requireFederation(req, reply)) return
    return { since: 'now', events: [] }
  })
  app.post<{ Body: { relation_id: string; body: string } }>(API.federationMessage, async (req, reply) => {
    if (!requireFederation(req, reply)) return
    const relationId = req.body?.relation_id
    const text = req.body?.body
    if (typeof relationId !== 'string' || typeof text !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: '参数缺失' })
    }
    if (text.length > cfg.message.max_length) {
      return reply.code(400).send({ error: 'bad_request', message: `消息限长 ${cfg.message.max_length} 字` })
    }
    // 对端发来的站内信(含解除连接通知):direction=in,管理端消息区/仪表盘待办可见
    repo.addFedMessage({ relation_id: relationId, body: text, direction: 'in' })
    return { ok: true }
  })

  /* ================= 管理端 ================= */
  app.get(API.adminStats, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const users = repo.getUsers()
    const today = new Date().toISOString().slice(0, 10)
    const todayNewUsers = users.filter((u) => String(u.registered_at ?? '').slice(0, 10) === today).length
    return {
      plugins_total: repo.countPlugins(),
      plugins_blocked: repo.countBlocked(),
      combos_published: repo.countCombosByStatus('published'),
      combos_pending: repo.countCombosByStatus('pending'),
      users_registered: repo.countUsers(),
      today_new_users: todayNewUsers,
      today_star_champion: repo.topPlugin()?.id ?? null,
      risk_pending: repo.getRiskQueue().filter((r) => r.status === 'pending').length,
    }
  })

  app.get(API.adminHealth, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    let disk: { used_gb: number | null; total_gb: number | null; pct: number | null } = { used_gb: null, total_gb: null, pct: null }
    try {
      const s = statfsSync(process.cwd())
      const total = Number(s.blocks) * Number(s.bsize)
      const free = Number(s.bavail) * Number(s.bsize)
      const used = total - free
      disk = {
        used_gb: Math.round((used / 1024 ** 3) * 10) / 10,
        total_gb: Math.round((total / 1024 ** 3) * 10) / 10,
        pct: total > 0 ? Math.round((used / total) * 100) : null,
      }
    } catch {
      /* 某些平台 statfs 不可用 → 返回 null，前端显示 — */
    }
    const apiErrorPct = runtime.apiRequests > 0 ? Math.round((runtime.apiErrors / runtime.apiRequests) * 1000) / 10 : null
    return {
      api_error_rate: apiErrorPct,
      api_requests: runtime.apiRequests,
      api_errors: runtime.apiErrors,
      github_sync: { at: sync.status.last_run_at ?? '—', changed: sync.status.last_changed, ok: sync.enabled },
      token_pool: { total: sync.status.tokens },
      disk,
      clock_drift_ms: runtime.clockDriftMs,
      rate_limited: runtime.rateLimited,
      auth_failures: runtime.authFailures,
      blocked_requests: runtime.blockedRequests,
    }
  })

  app.get<{ Querystring: { kind?: string } }>(API.adminPlugins, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const all = repo.getPlugins()
    const kind = req.query.kind
    if (kind === 'plugin') return all.filter((p) => p.kind !== 'preset')
    if (kind === 'agent' || kind === 'preset') return all.filter((p) => p.kind === 'preset')
    return all
  })

  /* ---- 插件库一键安全扫描（后台任务 + 进度轮询） ---- */
  app.get('/admin/scan/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    // 从未扫描过时 total=0（而非插件总数 4506）：前端据此不显示"已完成 0/N"误导横幅。
    return runtime.scanProgress ?? { running: false, total: 0, done: 0, current: null, failed: 0, risk: 0, started_at: null, finished_at: null }
  })
  app.post('/admin/scan', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const cur = runtime.scanProgress
    if (cur?.running) return { ...cur, message: '扫描进行中，请稍候' }
    const plugins = repo.getPlugins()
    if (plugins.length === 0) {
      return reply.code(400).send({ error: 'empty', message: '插件库为空，无可扫描目标（请先配置 GITHUB_TOKENS 完成同步）' })
    }
    runtime.scanProgress = { running: true, total: plugins.length, done: 0, current: null, failed: 0, risk: 0, started_at: new Date().toISOString(), finished_at: null }
    repo.log('admin', 'scan.all', { total: plugins.length })
    void (async () => {
      let done = 0
      let failed = 0
      let risk = 0
      const queue = [...plugins]
      // 双并发：unpkg/OSV 网络扫描，避免压垮上游
      const worker = async (): Promise<void> => {
        while (queue.length) {
          const p = queue.shift()
          if (!p) return
          if (runtime.scanProgress) runtime.scanProgress.current = p.id
          try {
            const profile = await scanPlugin({ pkg: p.id, version: p.version, repo: p.repo, presetName: p.preset_name })
            repo.setPluginSecurity(p.id, profile)
            if (profile.risk_tags.length > 0) risk++
          } catch {
            failed++
          }
          done++
          if (runtime.scanProgress) {
            runtime.scanProgress.done = done
            runtime.scanProgress.failed = failed
            runtime.scanProgress.risk = risk
          }
        }
      }
      await Promise.all([worker(), worker()])
      runtime.scanProgress = { running: false, total: plugins.length, done, current: null, failed, risk, started_at: runtime.scanProgress?.started_at ?? null, finished_at: new Date().toISOString() }
      repo.log('admin', 'scan.all.done', { done, failed, risk })
    })()
    return runtime.scanProgress
  })

  app.get(API.adminCombos, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    // 注入订阅数(替代本站点赞,组合页显示"订阅/下载")
    return repo.getCombos().map((c) => ({ ...c, subscribers: repo.comboSubscribers(c.name) }))
  })
  app.post<{ Body: { id: string; action: 'approve' | 'remove' | 'publish' | 'unpublish' } }>(API.adminCombos, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id, action } = req.body ?? {}
    // 兼容旧动作:approve=publish
    const next = action === 'remove' ? 'removed' as const : action === 'unpublish' ? 'unpublished' as const : 'published' as const
    const c = repo.setComboStatus(id, next)
    if (!c) return reply.code(404).send({ error: 'not_found' })
    repo.log('admin', `combo.${action}`, { id })
    // 给组作者发私人公告（仅作者可见,客户端公告列表自动过滤）。
    if (c.author_github) {
      const label = next === 'published' ? '已发布' : next === 'unpublished' ? '已下架' : '已删除'
      const a = repo.addAnnouncement({
        version: '*',
        level: 'info',
        content: `管理员已将你的组合「${c.name}」${label}。${next === 'unpublished' ? '如需重新上架请联系管理员。' : ''}`,
        user_id: c.author_github,
      })
      broadcast.publish('announcements', { id: a.id, version: a.version, user_id: a.user_id })
    }
    // 组合状态变化不再实时推送(省服务器资源)：客户端按 data_heartbeat_min 周期拉取。
    return c
  })

  app.get(API.adminUsers, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getUsers()
  })
  app.post<{ Body: { id: string; banned: boolean } }>(API.adminUsers, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id, banned } = req.body ?? {}
    const u = repo.setUserStatus(id, banned ? 'banned' : 'active')
    if (!u) return reply.code(404).send({ error: 'not_found' })
    repo.log('admin', banned ? 'user.ban' : 'user.unban', { id })
    return u
  })

  app.get(API.adminReports, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getReports()
  })
  app.post<{ Body: { id: number; status: 'included' | 'invalid' | 'rejected' } }>(API.adminReports, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id, status } = req.body ?? {}
    const r = repo.resolveReport(id, status)
    if (!r) return reply.code(404).send({ error: 'not_found' })
    repo.log('admin', `report.${status}`, { id })
    return r
  })

  /* ---- 风控队列（疑似刷赞：复核后生效或清除） ---- */
  app.get(API.adminRiskQueue, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getRiskQueue()
  })
  app.post<{ Body: { id: number; action: 'include' | 'reject' } }>(API.adminRiskQueue, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id, action } = req.body ?? {}
    if (typeof id !== 'number' || (action !== 'include' && action !== 'reject')) {
      return reply.code(400).send({ error: 'bad_request', message: 'id 与 action(include|reject) 必填' })
    }
    const r = repo.resolveRiskLike(id, action)
    if (!r) return reply.code(404).send({ error: 'not_found' })
    repo.log('admin', `risk.${action}`, { id })
    return r
  })

  app.post<{ Body: { repo_url: string } }>(API.adminFastTrack, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const repoUrl = req.body?.repo_url
    if (typeof repoUrl !== 'string' || !repoUrl.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: '仓库地址必填' })
    }
    const p = repo.fastTrack(repoUrl.trim())
    repo.log('admin', 'fast-track', { repo_url: repoUrl })
    // 事件驱动安全扫描（L0~L2），网络不可用自动降级不阻断
    const profile = await scanPlugin({ pkg: p.id, version: p.version, repo: p.repo, presetName: p.preset_name })
    repo.setPluginSecurity(p.id, profile)
    return { ...p, security: profile }
  })

  app.get(API.adminAnnouncements, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getAnnouncements()
  })
  app.post<{ Body: { version: string; level: 'info' | 'important'; content: string } }>(API.adminAnnouncements, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { version, level, content } = req.body ?? {}
    if (typeof version !== 'string' || !version.trim() || typeof content !== 'string' || !content.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: '版本号与内容必填' })
    }
    const a = repo.addAnnouncement({ version: version.trim(), level: level === 'important' ? 'important' : 'info', content })
    repo.log('admin', 'announcement.publish', { id: a.id })
    // 实时推送新公告(客户端立即刷新公告列表)。
    broadcast.publish('announcements', { id: a.id, version: a.version })
    return a
  })
  app.delete<{ Params: { id: string } }>(`${API.adminAnnouncements}/:id`, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (!repo.removeAnnouncement(req.params.id)) return reply.code(404).send({ error: 'not_found' })
    broadcast.publish('announcements', { removed: req.params.id })
    return { ok: true }
  })

  app.get(API.adminConfig, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getConfig()
  })
  app.put<{ Body: Partial<ServerConfig> }>(API.adminConfig, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const prevTokens = [...(repo.getConfig().sync.github_tokens ?? [])].map((t) => String(t).trim()).filter(Boolean)
    const next = { ...repo.getConfig(), ...(req.body ?? {}) } as ServerConfig
    // 适配：token 池去空去重；注册方式白名单（当前仅 github）；管理员口令不可置空（回落环境变量防锁死）
    next.sync.github_tokens = [...new Set((next.sync.github_tokens ?? []).map((t) => String(t).trim()).filter(Boolean))]
    if (!next.user.registration_methods?.length) next.user.registration_methods = ['github']
    next.user.registration_methods = next.user.registration_methods.filter((m) => m === 'github')
    if (!next.admin.password) next.admin.password = process.env.ADMIN_TOKEN ?? ''
    // 源连接密码与联邦密码：允许显式清空（清空 = 关闭对应校验）；类型不规范时回落为空。
    next.server.access_password = typeof next.server.access_password === 'string' ? next.server.access_password : ''
    next.federation.secret = typeof next.federation.secret === 'string' ? next.federation.secret : ''
    next.federation.enabled = next.federation.enabled !== false
    repo.setConfig(next)
    // ⚠ 关键：同步闭包快照 cfg —— 接口层(manifest/createCombo 等)读取的是 cfg 引用,
    // 不同步会导致"管理端改了配置、用户端/接口不生效"(如插件组审核开关)。
    Object.assign(cfg, next)
    // 密钥即时热更新：同步 token 池、OAuth/JWT、管理端口令全部生效
    sync.setTokens(next.sync.github_tokens)
    sync.setMaxRepos(next.sync.max_repos)
    auth.configure({ clientId: next.auth.github_client_id, clientSecret: next.auth.github_client_secret, jwtSecret: next.auth.jwt_secret })
    // 搜索 token 发生变化：仅重置下一次定时同步的倒计时，不立即执行；
    // 从"未启用 → 启用"同样等满一个完整间隔后才执行首次 GitHub 收录扫描。
    const tokensChanged = prevTokens.join(',') !== next.sync.github_tokens.join(',')
    if (tokensChanged) resetSyncSchedule()
    repo.log('admin', 'config.update', {})
    return repo.getConfig()
  })

  app.get(API.adminBlocklist, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return repo.getBlocklist()
  })
  app.post<{ Body: { pkg: string } }>(API.adminBlocklist, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const pkg = req.body?.pkg
    if (typeof pkg !== 'string' || !pkg.trim()) return reply.code(400).send({ error: 'bad_request' })
    repo.addBlocklist(pkg)
    repo.setPluginBlocked(pkg, true)
    repo.log('admin', 'blocklist.add', { pkg })
    return repo.getBlocklist()
  })
  app.delete<{ Params: { pkg: string } }>(`${API.adminBlocklist}/:pkg`, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    repo.removeBlocklist(req.params.pkg)
    repo.setPluginBlocked(req.params.pkg, false)
    return repo.getBlocklist()
  })

  app.get(API.adminFederation, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const fed = repo.getConfig().federation
    return {
      relations: repo.getFedRelations(),
      messages: repo.getFedMessages(),
      config: { enabled: fed.enabled, secret_configured: !!fed.secret },
    }
  })
  // 管理端「发送邀请」：本服务器代表管理员向对方服务器发起握手（携带对方联邦密码 + 选择同步类别），
  // 由对方 handshake 接口校验；浏览器不跨域直接调对方，避免 CORS 与密钥暴露面。
  app.post<{ Body: { peer_url: string; secret: string; mode?: 'snapshot' | 'realtime'; kinds?: string[] } }>('/admin/federation/invite', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const peerUrl = req.body?.peer_url?.trim()
    const secret = req.body?.secret
    if (!peerUrl) return reply.code(400).send({ error: 'bad_request', message: '对方服务器地址必填' })
    if (typeof secret !== 'string' || !secret) return reply.code(400).send({ error: 'bad_request', message: '对方联邦密码必填' })
    const kinds = Array.isArray(req.body?.kinds) ? (req.body.kinds as string[]).filter((k) => FED_KINDS.includes(k as FedSyncKind)) : [...FED_KINDS]
    // 本机对外地址：OAuth 场景同样依赖反代/域名的显式配置，优先 OAUTH_CALLBACK_URL。
    const self = (process.env.OAUTH_CALLBACK_URL ?? `${req.protocol}://${req.headers.host ?? '127.0.0.1:8080'}`).replace(/\/+$/, '')
    const peer = peerUrl.replace(/\/+$/, '')
    try {
      const res = await fetch(`${peer}/api/v1/federation/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Federation-Secret': secret, 'User-Agent': 'dsh-store-server' },
        body: JSON.stringify({ from_url: self, mode: req.body?.mode ?? 'snapshot', kinds }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        return reply.code(res.status === 401 ? 401 : 502).send({ error: 'peer_rejected', message: body?.message ?? `对方拒绝邀请（HTTP ${res.status}）` })
      }
    } catch {
      return reply.code(502).send({ error: 'peer_unreachable', message: '无法访问对方服务器：请确认地址可公网访问、且对方已开启联邦并配置联邦密码' })
    }
    const r = repo.addFedRelation({ peer_url: peer, mode: req.body?.mode ?? 'snapshot' })
    repo.updateFedShare(r.id, { kinds: kinds.join(',') })
    repo.log('admin', 'federation.invite', { peer, kinds })
    return { ok: true, message: '邀请已发送，等待对方管理员接受', id: r.id }
  })
  app.post<{ Body: { id: string; action: 'accept' | 'reject' | 'disconnect' } }>(API.adminFederation, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id, action } = req.body ?? {}
    const r = repo.setFedRelationStatus(id, action === 'accept' ? 'connected' : action === 'reject' ? 'rejected' : 'disconnected')
    if (!r) return reply.code(404).send({ error: 'not_found' })
    repo.log('admin', `federation.${action}`, { id })
    // 单方面解除：通知对方服务器(对方仪表盘待办/消息区可见)。
    if (action === 'disconnect' || action === 'reject') {
      const self = (process.env.OAUTH_CALLBACK_URL ?? `${req.protocol}://${req.headers.host ?? ''}`).replace(/\/+$/, '')
      repo.addFedMessage({ relation_id: r.id, body: `已向 ${self} 发送解除通知`, direction: 'out' })
      void fedSync.notifyPeer(r, `对方服务器 ${self} 已单方面解除联邦连接${action === 'reject' ? '（拒绝邀请）' : ''}`)
    }
    return r
  })
  /** 手动触发联邦同步（立即拉取全部已连接关系的已选类别；测试/即时同步用）。 */
  app.post('/admin/federation/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const results = await fedSync.runOnce()
    repo.log('admin', 'federation.sync.manual', { relations: results.length })
    return { ok: true, results }
  })

  app.get(API.adminUpdateStatus, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const platform = process.platform
    const dockerSocket = existsSync('/var/run/docker.sock')
    const rebuildScript = existsSync('/opt/dsh-store/api.run.sh')
    const track = repo.getConfig().update.track
    const current = deployedVersionTag()
    const latestRelease = runtime.latestRelease
    const latestCommit = runtime.latestCommit
    let hasUpdate = false
    if (track === 'commit' && latestCommit?.sha) {
      const short = latestCommit.sha.slice(0, 7)
      hasUpdate = current !== 'main' && current !== latestCommit.sha && !current.startsWith(short)
    } else if (latestRelease?.tag) {
      hasUpdate = normVersionTag(latestRelease.tag) !== normVersionTag(current)
    }
    return {
      ...repo.getUpdateState(),
      latest_release: latestRelease,
      latest_commit: latestCommit,
      track,
      repo_url: repo.getConfig().update.repo_url,
      current_version: current,
      has_update: hasUpdate,
      platform,
      panel_update_mode:
        platform !== 'linux'
          ? `当前平台 ${platform}：面板一键更新仅支持 Linux`
          : dockerSocket
            ? rebuildScript
              ? 'container'
              : 'container-self-bootstrap'
            : 'host-script',
    }
  })
  app.post('/admin/update/check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const repoUrl = repo.getConfig().update.repo_url
    if (!repoUrl) {
      return reply.code(400).send({ error: 'not_configured', message: '请先在下方「检测源」填写本项目 GitHub 仓库地址并保存（如 https://github.com/your-org/dsh-store-server）' })
    }
    const track = repo.getConfig().update.track
    const current = deployedVersionTag()
    if (track === 'commit') {
      const c = await sync.checkLatestCommit(repoUrl)
      runtime.latestCommit = c
      repo.log('admin', 'update.check', { track, repo_url: repoUrl, sha: c?.sha ?? null })
      if (!c) {
        return { mode: 'commit', latest_commit: null, current_version: current, has_update: false, message: '检测失败：无法访问 GitHub（请确认网络可访问、已配置 GITHUB_TOKENS、仓库地址正确）' }
      }
      const short = c.sha.slice(0, 7)
      // commit 通道的“当前版本”可能是：main（分支镜像）、完整/短 sha（commit 镜像）或版本 tag（release 镜像）。
      // 只有明确是 main / 该 sha 的镜像时才认为已是最新，避免容器部署下永远误报“有新提交”。
      const upToDate = current === 'main' || current === c.sha || current.startsWith(short)
      return { mode: 'commit', latest_commit: c, current_version: current, has_update: !upToDate, message: upToDate ? `已是最新提交 ${short}：${(c.message ?? '').split('\n')[0].slice(0, 60)}` : `最新提交 ${short}：${(c.message ?? '').split('\n')[0].slice(0, 60)}` }
    }
    const latest = await sync.checkLatestRelease(repoUrl)
    runtime.latestRelease = latest
    repo.log('admin', 'update.check', { track, repo_url: repoUrl, tag: latest?.tag ?? null })
    if (!latest?.tag) {
      return { mode: 'release', latest_release: null, current_version: current, has_update: false, message: '检测失败：无法访问 GitHub Releases（请确认网络可访问、已配置 GITHUB_TOKENS、仓库地址正确且已发布 Release）' }
    }
    const tag = normVersionTag(latest.tag)
    const hasUpdate = normVersionTag(current) !== tag
    return {
      mode: 'release',
      latest_release: { ...latest, tag },
      current_version: current,
      has_update: hasUpdate,
      message: hasUpdate ? `发现新版本 ${tag}（当前 ${current}）` : `已是最新版本（当前 ${tag}）`,
    }
  })
  app.get('/admin/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { ...sync.status, progress: sync.progress }
  })
  app.post('/admin/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (!sync.enabled) {
      return reply.code(503).send({ error: 'not_configured', message: '未配置 GITHUB_TOKENS' })
    }
    const run = sync.startRun(repo.syncTarget())
    void run.done
      .then(() => {
        repo.persistSync()
        // 实时推送插件库变更(客户端据此触发增量刷新)。
        broadcast.publish('plugins', { revision: repo.getPluginsRevision() })
      })
      .catch(() => {})
    return { started: run.started, status: sync.status, progress: run.progress }
  })
  app.post<{ Body: { version: string } }>(API.adminUpdate, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const version = req.body?.version
    const track = repo.getConfig().update.track
    // release 通道：v 前缀版本 tag（两位或三位，如 v0.1 / v0.1.0）；commit 通道：分支名或 commit sha（如 main）
    const valid = track === 'commit'
      ? typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(version)
      : typeof version === 'string' && /^v\d+\.\d+(\.\d+)?$/.test(version)
    if (!valid) {
      const hint = track === 'commit' ? '分支名或 commit sha（如 main）' : '版本号需匹配 ^v\\d+.\\d+(.\\d+)?（如 v0.1.0 或 v0.1）'
      return reply.code(400).send({ error: 'bad_request', message: hint })
    }
    repo.log('admin', 'update.run', { version, track })
    // 在线一键更新改为后台任务：立即返回初始状态，前端轮询 /admin/update/status 展示进度横幅。
    const running = updater.run(version)
    void running.catch(() => {})
    const state = repo.getUpdateState()
    if (state.stage === 'failed') {
      return reply.code(500).send({ ...state, error: state.error ?? '更新失败' })
    }
    return { started: true, ...state }
  })
}
