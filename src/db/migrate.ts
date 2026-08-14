import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getPool, closeDb } from './pool.js'

/**
 * 独立迁移器（docker-compose 的 migrate 一次性服务）：
 * 按文件名顺序执行 db/migrations/*.sql，已应用的记录在 schema_migrations 表中（幂等）。
 */
async function main(): Promise<void> {
  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'db/migrations')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const pool = getPool()
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
  const { rows } = await pool.query('SELECT version FROM schema_migrations')
  const done = new Set((rows as Array<{ version: string }>).map((r) => r.version))
  for (const f of files) {
    if (done.has(f)) continue
    const sql = await readFile(path.join(dir, f), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f])
      await client.query('COMMIT')
      console.log(`[migrate] 已应用 ${f}`)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
  console.log(`[migrate] 迁移完成（${files.length} 个文件，本次新应用 ${files.length - done.size} 个）`)
  await closeDb()
}

main().catch((e: unknown) => {
  console.error('[migrate] 失败:', e instanceof Error ? e.message : e)
  process.exit(1)
})
