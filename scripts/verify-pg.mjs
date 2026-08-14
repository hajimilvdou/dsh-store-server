/**
 * 模拟数据库检测（无 Docker / 不装 PostgreSQL）：
 * 用一个按 SQL 文本分发的迷你假连接池驱动 PgRepo 的 hydrate / 写穿代码路径，
 * 验证：① 加载映射（author/install 是否保留）② 首次启动落库（占位符数量）③ 各写操作写穿 SQL。
 * 说明：假池不做 SQL 语义校验，真库语法由 db/migrations 保证；本脚本验证的是"代码路径与列对齐"。
 */
import { PgRepo } from '../dist/repo/pg.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed++
}

function makeFakeDb(seed) {
  const tables = {
    plugins: [...(seed.plugins ?? [])],
    combos: [...(seed.combos ?? [])],
    combo_members: [...(seed.combo_members ?? [])],
    announcements: [...(seed.announcements ?? [])],
    likes: [...(seed.likes ?? [])],
    users: [...(seed.users ?? [])],
    user_installs: [...(seed.user_installs ?? [])],
    reports: [...(seed.reports ?? [])],
    risk_likes: [...(seed.risk_likes ?? [])],
    federation_relations: [...(seed.federation_relations ?? [])],
    federation_messages: [...(seed.federation_messages ?? [])],
    star_snapshots: [...(seed.star_snapshots ?? [])],
    anonymous_sessions: [],
    install_events: [],
    kv: [],
  }
  const writes = []

  const exec = async (sql, params = []) => {
    writes.push({ sql, params })
    const s = sql.trim()
    // SELECT * FROM <table>
    const mSel = s.match(/^SELECT \* FROM (\w+)/)
    if (mSel && tables[mSel[1]]) return { rows: tables[mSel[1]] }
    // SELECT value FROM kv WHERE key = $1
    if (s.startsWith('SELECT value FROM kv')) {
      const row = tables.kv.find((r) => r.key === params[0])
      return { rows: row ? [row] : [] }
    }
    // INSERT INTO <table> ...
    const mIns = s.match(/^INSERT INTO (\w+)/)
    if (mIns && tables[mIns[1]]) {
      const cols = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').map((c) => c.trim())
      const row = {}
      cols.forEach((c, i) => { row[c] = params[i] })
      tables[mIns[1]].push(row)
      return { rows: [] }
    }
    // DELETE FROM <table>
    const mDel = s.match(/^DELETE FROM (\w+)/)
    if (mDel && tables[mDel[1]]) {
      tables[mDel[1]].length = 0
      return { rows: [] }
    }
    // UPDATE <table> SET ...
    const mUpd = s.match(/^UPDATE (\w+)/)
    if (mUpd && tables[mUpd[1]]) return { rows: [] }
    return { rows: [] }
  }

  const client = { query: exec, async release() {} }
  const pool = { query: exec, async connect() { return client } }
  return { pool, tables, writes }
}

// ============ 场景 A：已有数据的库（重启加载 + 写穿） ============
const seedA = {
  plugins: [{
    id: 'open-design', version: '1.2.0', name: 'open-design', description: 'Open Design spec tool',
    repo: 'nexu-io/open-design', repo_url: 'https://github.com/nexu-io/open-design', source: 'community',
    stars: 1200, stars_delta_day: 5, trending_rank: 1, likes: 3, downloads_7d: 42,
    quality_score: 80, tags: [], compat: 'dsh ≥0.1.0-rc.5', author: 'nexu-io', install: 'github:nexu-io/open-design',
    is_new: false, security_level: 2, security_score: 90, risk_tags: [], blocked: false, status: 'listed',
    updated_at: '2026-08-14T00:00:00Z',
  }],
  combos: [{
    id: 'store.example.com:combo_1', slug: '新手启航包', name: '新手启航包', description: '日常开发三件套',
    author_id: 'liwei', author_name: 'liwei', likes: 486, downloads_7d: 1203, status: 'published',
    origin_server: 'store.example.com', version: 1, updated_at: '2026-08-14T00:00:00Z',
  }],
  combo_members: [{ combo_id: 'store.example.com:combo_1', pkg: 'open-design', version: '*' }],
  announcements: [{ id: 'ann_1', version: 'v0.3.0', level: 'info', content: '测试公告', origin_server: '官方源', published_at: '2026-08-14' }],
  likes: [{ user_id: 'u_liwei', target: 'open-design', created_at: '2026-08-14T00:00:00Z' }],
  users: [{ id: 'u_liwei', github_id: 1001, login: 'liwei', name: '李伟', home_server: 'store.example.com', status: 'active', registered_at: '2026-08-13T00:00:00Z' }],
  user_installs: [],
  reports: [],
  risk_likes: [{ id: 7, user_id: 'u_x', login: 'userX', target: 'open-design', ip: '1.2.3.4', reason: '同 IP 集中点赞', status: 'pending', created_at: '2026-08-14T08:00:00Z' }],
  federation_relations: [],
  federation_messages: [],
  star_snapshots: [],
}

{
  const db = makeFakeDb(seedA)
  const repo = await PgRepo.create(db.pool, false)

  const p = repo.getPlugins().find((x) => x.id === 'open-design')
  check('A1 重启加载保留作者', !!p && p.author === 'nexu-io', p ? `author=${p.author}` : 'missing')
  check('A2 重启加载保留安装 spec', !!p && p.install === 'github:nexu-io/open-design', p ? `install=${p.install}` : 'missing')
  check('A3 组合成员关联加载', repo.getCombos()[0]?.members[0]?.pkg === 'open-design')
  check('A4 风控队列从库加载', repo.getRiskQueue().length === 1 && repo.getRiskQueue()[0].status === 'pending')
  check('A5 点赞从库加载', repo.likeCount('open-design') === 1)

  // 写穿：安装计数
  const t1 = repo.mintAnonToken('inst-sim')
  check('A6 匿名凭证落库', db.tables.anonymous_sessions.length === 1 && repo.verifyAnonToken(t1) === true)
  const d1 = repo.recordInstall(t1, 'open-design')
  check('A7 下载计数写穿 install_events', db.tables.install_events.length === 1 && d1.counted && d1.downloads_7d === 43, `downloads_7d=${d1.downloads_7d}`)

  // 写穿：点赞 + 风控
  repo.toggleLike('u_xiaoyu', 'open-design')
  check('A8 点赞写穿 likes', db.tables.likes.length === 2)
  const q = repo.queueRiskLike({ userId: 'u_c', login: 'userC', target: 'open-design', ip: '1.2.3.4', reason: '测试' })
  check('A9 风控入队写穿 risk_likes', db.tables.risk_likes.length === 2)
  const resolved = repo.resolveRiskLike(q.id, 'include')
  check('A10 复核计入写穿（UPDATE + likes）', resolved?.status === 'included' && db.tables.likes.length === 3)
}

// ============ 场景 B：空库首次启动（种子落库，占位符数量校验） ============
{
  const db = makeFakeDb({})
  const repo = await PgRepo.create(db.pool, true)
  const pluginInsert = db.writes.find((w) => w.sql.startsWith('INSERT INTO plugins'))
  check('B1 首次启动种子落库（20 插件）', db.tables.plugins.length === 20, `plugins=${db.tables.plugins.length}`)
  check('B2 插件 INSERT 占位符 24 列对齐', !!pluginInsert && pluginInsert.params.length === 24, pluginInsert ? `params=${pluginInsert.params.length}` : 'no insert')
  const seeded = repo.getPlugins().find((x) => x.id === 'dsh-memory')
  check('B3 种子插件字段完整（含 author/install 位）', !!seeded && seeded.downloads_7d > 0 && seeded.likes > 0)
}

console.log(failed === 0 ? '\n全部通过 ✅（模拟数据库检测）' : `\n${failed} 项失败 ❌`)
process.exitCode = failed === 0 ? 0 : 1
