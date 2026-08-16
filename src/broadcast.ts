import type { FastifyReply } from 'fastify'

/**
 * SSE 广播器（Server-Sent Events）：管理长连接集合，向所有订阅者推送事件。
 * - 广播型数据（点赞数 / 公告 / 插件库变更）所有客户端看同一份，SSE 单向推送足够；
 * - 单实例直连即可；多实例（LB 集群）时需接入 Redis pub/sub（项目已依赖 ioredis），此处预留扩展点。
 */
export class Broadcast {
  private clients = new Set<FastifyReply>()
  private seq = 0

  /** 当前订阅连接数（监控/调试用）。 */
  get clientCount(): number {
    return this.clients.size
  }

  /** 注册 SSE 连接，返回取消订阅函数（连接关闭时自动移除）。 */
  subscribe(reply: FastifyReply): () => void {
    this.clients.add(reply)
    reply.raw.on('close', () => {
      this.clients.delete(reply)
    })
    return () => {
      this.clients.delete(reply)
    }
  }

  /** 广播事件：`event: <type>` + `data: <json>`。写入失败（连接已断）的连接自动剔除。 */
  publish(type: string, data: Record<string, unknown>): void {
    if (this.clients.size === 0) return
    const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`
    for (const reply of this.clients) {
      try {
        reply.raw.write(payload)
      } catch {
        this.clients.delete(reply)
      }
    }
    this.seq++
  }
}
