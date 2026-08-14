/**
 * 时钟漂移自检（v3.6 U5）：容器共享宿主机时钟，关键在宿主机 NTP；
 * 应用侧比对可信源（HTTPS Date 头）：
 * - 漂移 > 500ms → 监控页告警；
 * - 漂移 > 5s → 拒绝签发时间敏感凭证（JWT/签名）。
 */
export async function checkClockDrift(): Promise<number> {
  try {
    const t0 = Date.now()
    const res = await fetch('https://registry.npmjs.org/-/ping', { method: 'HEAD' })
    const date = res.headers.get('date')
    if (!date) return 0
    const t1 = Date.now()
    const serverTime = Date.parse(date)
    if (Number.isNaN(serverTime)) return 0
    return Math.round((t0 + t1) / 2 - serverTime)
  } catch {
    return 0
  }
}
