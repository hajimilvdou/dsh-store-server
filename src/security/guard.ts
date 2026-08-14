import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RateLimiter } from './ratelimit.js'

/** 同类告警去抖发送（飞书/钉钉通用 text 格式；其他通道后续按 webhook 类型配置）。 */
export class AlertService {
  private lastSent = new Map<string, number>()

  constructor(private readonly webhookUrl: string) {}

  get enabled(): boolean {
    return !!this.webhookUrl
  }

  async send(title: string, text: string): Promise<void> {
    if (!this.webhookUrl) return
    const now = Date.now()
    const last = this.lastSent.get(title) ?? 0
    if (now - last < 5 * 60_000) return
    this.lastSent.set(title, now)
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: `[dsh-store] ${title}\n${text}` } }),
      })
    } catch {
      /* 发送失败忽略（告警通道本身不可用时不阻塞业务） */
    }
  }
}

/** 运行时状态（守卫计数 + 时钟漂移 + 更新检测，供安全监控页/健康接口展示）。 */
export interface RuntimeState {
  clockDriftMs: number
  rateLimited: number
  authFailures: number
  blockedRequests: number
  /** 进程累计 API 请求数（健康页错误率 = apiErrors / apiRequests，启动后累计口径）。 */
  apiRequests: number
  apiErrors: number
  latestRelease: { tag: string | null; name: string | null; published_at: string | null; body: string | null } | null
}

/**
 * 防护守卫（v3.2 S8）：
 * - 读接口按 IP 全局限流（120/min）；
 * - 写接口用户 + IP 双维度限流（30/min，登录维度由 requireUser 失败计数兜底）；
 * - 认证端点防爆破（10/min）。
 * - 匿名写接口（下载计数等）的匿名 token 门槛在对应端点实现时接入。
 * 触发限流 → 429 + 告警；计数进 RuntimeState 供监控页展示。
 */
export function installGuards(app: FastifyInstance, alerts: AlertService, runtime: RuntimeState): void {
  const reads = new RateLimiter(60_000, 120)
  const writes = new RateLimiter(60_000, 30)
  const authz = new RateLimiter(60_000, 10)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.ip ?? 'unknown'
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
    const isAuth = req.url.startsWith('/auth/')
    const limiter = isAuth ? authz : isWrite ? writes : reads
    const r = limiter.allow(ip)
    if (!r.ok) {
      runtime.rateLimited++
      void alerts.send('限流触发', `IP ${ip} 超过限制：${req.method} ${req.url}`)
      return reply.code(429).send({ error: 'rate_limited', message: '请求过于频繁，请稍后再试' })
    }
  })

  // 真实请求/错误计数（健康页错误率数据源）
  app.addHook('onResponse', async (_req: FastifyRequest, reply: FastifyReply) => {
    runtime.apiRequests++
    if (reply.statusCode >= 500) runtime.apiErrors++
  })
}
