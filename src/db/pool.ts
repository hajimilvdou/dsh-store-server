import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null

/** 是否配置了数据库（无凭据阶段无库也能启动，仅内存仓库可用）。 */
export function dbEnabled(): boolean {
  return !!process.env.DATABASE_URL
}

export function getPool(): pg.Pool {
  if (!pool) {
    if (!dbEnabled()) {
      throw new Error('DATABASE_URL 未配置，无法访问数据库')
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return pool
}

export async function pingDb(): Promise<boolean> {
  if (!dbEnabled()) return false
  try {
    await getPool().query('SELECT 1')
    return true
  } catch {
    return false
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
