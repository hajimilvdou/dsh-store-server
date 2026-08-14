import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 轻量 .env 加载（不引入 dotenv）：
 * 启动时把仓库根 .env 中未由外部环境注入的键合并进 process.env。
 * 生产环境（Docker）直接用环境变量注入，.env 不存在时静默跳过。
 */
export function loadEnvFile(): void {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')
    const content = readFileSync(file, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    // 无 .env 时忽略
  }
}
