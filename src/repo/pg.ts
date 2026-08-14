import pg from 'pg'
import type { Announcement, Combo, Plugin, RiskTag, User } from '../shared/models.js'
import { DEFAULT_CONFIG, type ServerConfig } from '../shared/config.js'
import { MemoryRepo } from './memory.js'
import type { CloudInstall, FedMessage, FedRelation, StoredReport, StoredRiskLike, UpdateState } from './data.js'

interface PluginRow {
  id: string
  version: string
  name: string
  description: string
  repo: string
  repo_url: string
  source: 'official' | 'community'
  stars: number
  stars_delta_day: number
  trending_rank: number | null
  likes: number
  downloads_7d: number
  quality_score: number
  tags: string[]
  compat: string
  /** 作者（GitHub 仓库 owner）。 */
  author: string
  /** 安装 spec：npm 包名或 github:owner/repo。 */
  install: string
  is_new: boolean
  security_level: number
  security_score: number
  risk_tags: string[]
  blocked: boolean
  status: Plugin['status']
  updated_at: string
}

function rowToPlugin(r: PluginRow): Plugin {
  return {
    id: r.id,
    version: r.version,
    name: r.name,
    description: r.description,
    repo: r.repo,
    repo_url: r.repo_url,
    source: r.source,
    stars: r.stars,
    stars_delta_day: r.stars_delta_day,
    trending_rank: r.trending_rank,
    likes: r.likes,
    downloads_7d: r.downloads_7d,
    quality_score: r.quality_score,
    tags: r.tags,
    compat: r.compat,
    author: r.author,
    install: r.install,
    is_new: r.is_new,
    security: { level: r.security_level as 0 | 1 | 2 | 3, score: r.security_score, risk_tags: r.risk_tags as RiskTag[], blocked: r.blocked },
    status: r.status,
    updated_at: r.updated_at,
  }
}

function pluginToRow(p: Plugin): unknown[] {
  return [
    p.id, p.version, p.name, p.description, p.repo, p.repo_url, p.source, p.stars, p.stars_delta_day,
    p.trending_rank, p.likes, p.downloads_7d, p.quality_score, JSON.stringify(p.tags), p.compat,
    // author/install 列 NOT NULL：数据缺失时用安全占位，绝不落 NULL（否则首启种子落库直接崩溃）
    p.author || '社区', p.install || '',
    p.is_new,
    p.security.level, p.security.score, JSON.stringify(p.security.risk_tags), p.security.blocked, p.status, p.updated_at,
  ]
}

const PLUGIN_COLS = 'id, version, name, description, repo, repo_url, source, stars, stars_delta_day, trending_rank, likes, downloads_7d, quality_score, tags, compat, author, install, is_new, security_level, security_score, risk_tags, blocked, status, updated_at'
const PLUGIN_PLACEHOLDERS = Array.from({ length: 24 }, (_, i) => `$${i + 1}`).join(',')

/**
 * PostgreSQL 仓库（v3.5 D1）：启动时从 PG 加载全量工作集到内存（数据量小），
 * 每次写操作同步更新内存并**写穿**到 PG（fire-and-forget，失败记日志不丢内存态）。
 * 首次启动（空库）自动把种子数据落库。
 * TODO: 写穿改为 await 语义（接口方法 async 化）以获得严格写后读一致性。
 */
export class PgRepo extends MemoryRepo {
  private constructor(
    private readonly pool: pg.Pool,
    seedDemo: boolean,
  ) {
    super(seedDemo)
  }

  static async create(pool: pg.Pool, seedDemo = false): Promise<PgRepo> {
    const repo = new PgRepo(pool, seedDemo)
    await repo.hydrate()
    return repo
  }

  private fire(sql: string, params: unknown[] = []): void {
    void this.pool.query(sql, params).catch((e) => console.error('[pg] 写穿失败:', e instanceof Error ? e.message : e))
  }

  private async kvGet<T>(key: string, fallback: T): Promise<T> {
    const { rows } = await this.pool.query('SELECT value FROM kv WHERE key = $1', [key])
    return rows.length ? (rows[0].value as T) : fallback
  }

  private kvSet(key: string, value: unknown): void {
    this.fire('INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, JSON.stringify(value)])
  }

  private async hydrate(): Promise<void> {
    const { rows: pRows } = await this.pool.query('SELECT * FROM plugins ORDER BY trending_rank NULLS LAST, stars DESC')
    if (pRows.length === 0) {
      // 首次启动：种子落库
      await this.persistAll()
      return
    }
    this.plugins = (pRows as PluginRow[]).map(rowToPlugin)

    const { rows: cRows } = await this.pool.query('SELECT * FROM combos')
    const { rows: mRows } = await this.pool.query('SELECT * FROM combo_members')
    const membersByCombo = new Map<string, Array<{ pkg: string; version: string }>>()
    for (const m of mRows as Array<{ combo_id: string; pkg: string; version: string }>) {
      const list = membersByCombo.get(m.combo_id) ?? []
      list.push({ pkg: m.pkg, version: m.version })
      membersByCombo.set(m.combo_id, list)
    }
    this.combos = (cRows as Array<{ id: string; slug: string; name: string; description: string; author_name: string; author_id: string | null; likes: number; downloads_7d: number; status: Combo['status']; origin_server: string; version: number; updated_at: string }>).map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      members: membersByCombo.get(c.id) ?? [],
      author: c.author_name,
      author_github: c.author_id,
      likes: c.likes,
      downloads_7d: c.downloads_7d,
      status: c.status,
      origin_server: c.origin_server,
      version: c.version,
      updated_at: c.updated_at,
    }))

    // 存量下载量折算进当日聚合基线，避免重启后事件重算清零
    this.baselineDailyDownloads()

    const { rows: aRows } = await this.pool.query('SELECT * FROM announcements ORDER BY published_at DESC')
    this.announcements = (aRows as Announcement[]).map((a) => ({ ...a }))

    const { rows: lRows } = await this.pool.query('SELECT * FROM likes')
    this.likes = (lRows as Array<{ user_id: string; target: string; created_at: string }>).map((l) => ({ user_id: l.user_id, target: l.target, at: l.created_at }))

    const { rows: uRows } = await this.pool.query('SELECT * FROM users')
    this.users = (uRows as Array<{ id: string; github_id: number; login: string; name: string | null; home_server: string; status: User['status']; registered_at: string }>).map((u) => ({
      id: u.id,
      github_id: u.github_id,
      login: u.login,
      name: u.name,
      home_server: u.home_server,
      status: u.status,
      registered_at: u.registered_at,
      combo_count: this.combos.filter((c) => c.author === u.login && c.status !== 'removed').length,
    }))

    const { rows: iRows } = await this.pool.query('SELECT * FROM user_installs')
    this.installs = (iRows as Array<{ user_id: string; target: string; type: 'plugin' | 'combo'; version: string; source_combo_id: string | null; at: string }>).map((i) => ({ ...i }))

    const { rows: rRows } = await this.pool.query('SELECT * FROM reports ORDER BY id')
    this.reports = (rRows as StoredReport[]).map((r) => ({ ...r }))

    const { rows: kRows } = await this.pool.query('SELECT * FROM risk_likes ORDER BY id')
    this.riskQueue = (kRows as Array<{ id: number; user_id: string; login: string; target: string; ip: string; reason: string; status: StoredRiskLike['status']; created_at: string }>).map((r) => ({ id: r.id, user_id: r.user_id, login: r.login, target: r.target, ip: r.ip, reason: r.reason, status: r.status, at: r.created_at }))
    this.riskSeq = this.riskQueue.reduce((m, r) => Math.max(m, r.id), 0)

    const { rows: fRows } = await this.pool.query('SELECT * FROM federation_relations')
    this.fedRelations = (fRows as Array<{ id: string; peer_url: string; status: FedRelation['status']; share: Record<string, string>; mode: 'snapshot' | 'realtime'; created_at: string }>).map((f) => ({ id: f.id, peer_url: f.peer_url, status: f.status, share: f.share, mode: f.mode, rtt_ms: null, created_at: f.created_at }))

    const { rows: msgRows } = await this.pool.query('SELECT * FROM federation_messages ORDER BY id')
    this.fedMessages = (msgRows as FedMessage[]).map((m) => ({ ...m }))

    const { rows: sRows } = await this.pool.query('SELECT * FROM star_snapshots')
    this.starSnapshots = (sRows as Array<{ repo: string; date: string; stars: number }>).map((s) => ({ repo: s.repo, date: String(s.date).slice(0, 10), stars: s.stars }))

    this.config = { ...structuredClone(DEFAULT_CONFIG), ...(await this.kvGet<ServerConfig>('config', this.config)) }
    this.updateState = await this.kvGet<UpdateState>('update_state', this.updateState)
    this.blocklist = await this.kvGet<string[]>('blocklist', [])
    this.pluginsRevision = await this.kvGet<number>('plugins_revision', this.pluginsRevision)
    this.combosRevision = await this.kvGet<number>('combos_revision', this.combosRevision)
  }

  /** 全量落库（首次启动种子 / 同步后兜底）。 */
  async persistAll(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM combo_members')
      await client.query('DELETE FROM combos')
      await client.query('DELETE FROM plugins')
      await client.query('DELETE FROM user_installs')
      await client.query('DELETE FROM federation_messages')
      await client.query('DELETE FROM federation_relations')
      await client.query('DELETE FROM star_snapshots')
      await client.query('DELETE FROM risk_likes')
      for (const p of this.plugins) {
        await client.query(`INSERT INTO plugins (${PLUGIN_COLS}) VALUES (${PLUGIN_PLACEHOLDERS})`, pluginToRow(p))
      }
      for (const c of this.combos) {
        await client.query(
          `INSERT INTO combos (id, slug, name, description, author_id, author_name, likes, downloads_7d, status, origin_server, version, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [c.id, c.slug, c.name, c.description, c.author_github, c.author, c.likes, c.downloads_7d, c.status, c.origin_server, c.version, c.updated_at],
        )
        for (const m of c.members) {
          await client.query('INSERT INTO combo_members (combo_id, pkg, version) VALUES ($1,$2,$3)', [c.id, m.pkg, m.version])
        }
      }
      for (const i of this.installs) {
        await client.query(
          'INSERT INTO user_installs (user_id, target, type, version, source_combo_id, at) VALUES ($1,$2,$3,$4,$5,$6)',
          [i.user_id, i.target, i.type, i.version, i.source_combo_id, i.at],
        )
      }
      for (const s of this.starSnapshots) {
        await client.query('INSERT INTO star_snapshots (repo, date, stars) VALUES ($1,$2,$3)', [s.repo, s.date, s.stars])
      }
      for (const r of this.riskQueue) {
        await client.query('INSERT INTO risk_likes (id, user_id, login, target, ip, reason, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.id, r.user_id, r.login, r.target, r.ip, r.reason, r.status, r.at])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    this.kvSet('config', this.config)
    this.kvSet('update_state', this.updateState)
    this.kvSet('blocklist', this.blocklist)
    this.kvSet('plugins_revision', this.pluginsRevision)
    this.kvSet('combos_revision', this.combosRevision)
  }

  /** 同步管线落库（插件 + 星数快照）。 */
  async persistSync(): Promise<void> {
    for (const p of this.plugins) {
      this.fire(
        `INSERT INTO plugins (${PLUGIN_COLS}) VALUES (${PLUGIN_PLACEHOLDERS})
         ON CONFLICT (id) DO UPDATE SET stars = EXCLUDED.stars, stars_delta_day = EXCLUDED.stars_delta_day, trending_rank = EXCLUDED.trending_rank, is_new = EXCLUDED.is_new, author = EXCLUDED.author, install = EXCLUDED.install, updated_at = EXCLUDED.updated_at`,
        pluginToRow(p),
      )
    }
    this.kvSet('plugins_revision', this.pluginsRevision)
  }

  /* ---- 写穿覆盖 ---- */

  override toggleLike(userId: string, target: string): { count: number; liked: boolean } {
    const r = super.toggleLike(userId, target)
    if (r.liked) this.fire('INSERT INTO likes (user_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, target])
    else this.fire('DELETE FROM likes WHERE user_id = $1 AND target = $2', [userId, target])
    return r
  }

  override applyLikeCount(target: string, count: number): void {
    super.applyLikeCount(target, count)
    this.fire('UPDATE plugins SET likes = $1 WHERE id = $2', [count, target])
    this.fire('UPDATE combos SET likes = $1 WHERE id = $2', [count, target])
  }

  override createCombo(input: { name: string; description: string; members: string[]; author: string; authorGithub: string }): Combo {
    const c = super.createCombo(input)
    this.fire('INSERT INTO combos (id, slug, name, description, author_id, author_name, likes, downloads_7d, status, origin_server, version, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [c.id, c.slug, c.name, c.description, c.author_github, c.author, c.likes, c.downloads_7d, c.status, c.origin_server, c.version, c.updated_at])
    for (const m of c.members) this.fire('INSERT INTO combo_members (combo_id, pkg, version) VALUES ($1,$2,$3)', [c.id, m.pkg, m.version])
    this.kvSet('combos_revision', this.combosRevision)
    return c
  }

  override setComboStatus(id: string, status: Combo['status']): Combo | null {
    const c = super.setComboStatus(id, status)
    if (c) {
      this.fire('UPDATE combos SET status = $1, updated_at = now() WHERE id = $2', [status, id])
      this.kvSet('combos_revision', this.combosRevision)
    }
    return c
  }

  override replaceInstalls(userId: string, list: Array<{ target: string; type: 'plugin' | 'combo'; version: string }>): CloudInstall[] {
    const out = super.replaceInstalls(userId, list)
    this.fire('DELETE FROM user_installs WHERE user_id = $1', [userId])
    for (const it of out) this.fire('INSERT INTO user_installs (user_id, target, type, version, source_combo_id, at) VALUES ($1,$2,$3,$4,$5,$6)', [userId, it.target, it.type, it.version, it.source_combo_id, it.at])
    return out
  }

  override deactivateUser(userId: string, login: string, combos: 'delete' | 'anonymize'): { ok: boolean; deleted: { likes: number; installs: number; combos: number } } {
    const r = super.deactivateUser(userId, login, combos)
    this.fire('DELETE FROM likes WHERE user_id = $1', [userId])
    this.fire('DELETE FROM user_installs WHERE user_id = $1', [userId])
    this.fire('DELETE FROM users WHERE id = $1', [userId])
    if (combos === 'delete') this.fire('DELETE FROM combos WHERE author_id = $1', [login])
    else this.fire('UPDATE combos SET author_name = $1, author_id = NULL WHERE author_id = $2', ['已注销用户', login])
    this.kvSet('combos_revision', this.combosRevision)
    return r
  }

  override addAnnouncement(input: { version: string; level: 'info' | 'important'; content: string }): Announcement {
    const a = super.addAnnouncement(input)
    this.fire('INSERT INTO announcements (id, version, level, content, origin_server, published_at) VALUES ($1,$2,$3,$4,$5,$6)', [a.id, a.version, a.level, a.content, a.origin_server, a.published_at])
    return a
  }

  override removeAnnouncement(id: string): boolean {
    const ok = super.removeAnnouncement(id)
    if (ok) this.fire('DELETE FROM announcements WHERE id = $1', [id])
    return ok
  }

  override addReport(input: { pkg: string; repo_url: string | null; version: string }): StoredReport {
    const r = super.addReport(input)
    this.fire('INSERT INTO reports (pkg, repo_url, version, reporter_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [r.pkg, r.repo_url, r.version, r.reporter_id, r.status, r.created_at])
    return r
  }

  override resolveReport(id: number, status: 'included' | 'invalid' | 'rejected'): StoredReport | null {
    const r = super.resolveReport(id, status)
    if (r) this.fire('UPDATE reports SET status = $1 WHERE id = $2', [status, id])
    return r
  }

  override fastTrack(repoUrl: string): Plugin {
    const p = super.fastTrack(repoUrl)
    this.fire(`INSERT INTO plugins (${PLUGIN_COLS}) VALUES (${PLUGIN_PLACEHOLDERS})`, pluginToRow(p))
    this.kvSet('plugins_revision', this.pluginsRevision)
    return p
  }

  override setPluginSecurity(id: string, security: Plugin['security']): void {
    super.setPluginSecurity(id, security)
    this.fire('UPDATE plugins SET security_level = $1, security_score = $2, risk_tags = $3, blocked = $4 WHERE id = $5', [security.level, security.score, JSON.stringify(security.risk_tags), security.blocked, id])
  }

  override setUserStatus(id: string, status: User['status']): User | null {
    const u = super.setUserStatus(id, status)
    if (u) this.fire('UPDATE users SET status = $1 WHERE id = $2', [status, id])
    return u
  }

  override setConfig(cfg: ServerConfig): void {
    super.setConfig(cfg)
    this.kvSet('config', cfg)
  }

  override addBlocklist(pkg: string): void {
    super.addBlocklist(pkg)
    this.kvSet('blocklist', this.blocklist)
  }

  override removeBlocklist(pkg: string): void {
    super.removeBlocklist(pkg)
    this.kvSet('blocklist', this.blocklist)
  }

  override setPluginBlocked(pkg: string, blocked: boolean): void {
    super.setPluginBlocked(pkg, blocked)
    this.fire('UPDATE plugins SET blocked = $1, status = $2 WHERE id = $3', [blocked, blocked ? 'blocked' : 'listed', pkg])
    this.kvSet('plugins_revision', this.pluginsRevision)
  }

  override addFedRelation(input: { peer_url: string; mode: 'snapshot' | 'realtime' }): FedRelation {
    const r = super.addFedRelation(input)
    this.fire('INSERT INTO federation_relations (id, peer_url, status, share, mode, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [r.id, r.peer_url, r.status, JSON.stringify(r.share), r.mode, r.created_at])
    return r
  }

  override setFedRelationStatus(id: string, status: FedRelation['status']): FedRelation | null {
    const r = super.setFedRelationStatus(id, status)
    if (r) this.fire('UPDATE federation_relations SET status = $1, updated_at = now() WHERE id = $2', [status, id])
    return r
  }

  override addFedMessage(input: { relation_id: string; body: string }): void {
    super.addFedMessage(input)
    this.fire('INSERT INTO federation_messages (relation_id, direction, body) VALUES ($1,$2,$3)', [input.relation_id, 'out', input.body])
  }

  override setUpdateState(state: UpdateState): void {
    super.setUpdateState(state)
    this.kvSet('update_state', state)
  }

  override mintAnonToken(instanceId: string): string {
    const token = super.mintAnonToken(instanceId)
    this.fire('INSERT INTO anonymous_sessions (token, instance_id, expires_at) VALUES ($1,$2,now() + interval \'1 hour\')', [token, instanceId])
    return token
  }

  override recordInstall(token: string, target: string): { ok: boolean; counted: boolean; downloads_7d: number } {
    const r = super.recordInstall(token, target)
    if (r.ok && r.counted) this.fire('INSERT INTO install_events (token, target) VALUES ($1,$2)', [token, target])
    return r
  }

  override queueRiskLike(input: { userId: string; login: string; target: string; ip: string; reason: string }): StoredRiskLike {
    const r = super.queueRiskLike(input)
    this.fire('INSERT INTO risk_likes (id, user_id, login, target, ip, reason, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.id, r.user_id, r.login, r.target, r.ip, r.reason, r.status, r.at])
    return r
  }

  override ensureLike(userId: string, target: string): void {
    const before = this.likes.some((l) => l.user_id === userId && l.target === target)
    super.ensureLike(userId, target)
    if (!before) this.fire('INSERT INTO likes (user_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, target])
  }

  override resolveRiskLike(id: number, action: 'include' | 'reject'): StoredRiskLike | null {
    const r = super.resolveRiskLike(id, action)
    if (r) this.fire('UPDATE risk_likes SET status = $1 WHERE id = $2', [r.status, id])
    return r
  }

  override log(actor: string, action: string, detail: Record<string, unknown>): void {
    super.log(actor, action, detail)
    this.fire('INSERT INTO audit_log (actor, action, detail) VALUES ($1,$2,$3)', [actor, action, JSON.stringify(detail)])
  }
}
