/** 固定窗口限流器（内存实现，单机 2C4G 足够；LB 集群后续可换 Redis 版本）。 */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  allow(key: string): { ok: boolean; remaining: number } {
    const now = Date.now()
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (arr.length >= this.max) {
      this.hits.set(key, arr)
      return { ok: false, remaining: 0 }
    }
    arr.push(now)
    this.hits.set(key, arr)
    return { ok: true, remaining: this.max - arr.length }
  }
}
