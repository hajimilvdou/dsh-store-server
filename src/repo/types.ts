import type { Announcement, Combo, Plugin, User } from '../shared/models.js'
import type { Delta, NodeInfo } from '../shared/protocol.js'
import type { ServerConfig } from '../shared/config.js'
import type { SyncTarget } from '../sync/github.js'
import type { CloudInstall, FedMessage, FedRelation, StoredLike, StoredReport, StoredRiskLike, UpdateState } from './data.js'

/**
 * 仓库接口：路由只面向此接口，不直接改字段。
 * MemoryRepo（无凭据联调）与 PgRepo（PostgreSQL）均可实现。
 */
export interface Repo {
  /* ---- 读 ---- */
  getPlugins(): Plugin[]
  getCombos(): Combo[]
  getAnnouncements(): Announcement[]
  getNodes(): NodeInfo[]
  getUsers(): User[]
  getReports(): StoredReport[]
  getLikes(): StoredLike[]
  installsOf(userId: string): CloudInstall[]
  getFedRelations(): FedRelation[]
  getFedMessages(): FedMessage[]
  getBlocklist(): string[]
  getConfig(): ServerConfig
  getUpdateState(): UpdateState
  getPluginsRevision(): number
  getCombosRevision(): number
  pluginsDelta(since?: string): Delta<Plugin>
  combosDelta(since?: string): Delta<Combo>
  likeCount(target: string): number
  countPlugins(): number
  countBlocked(): number
  countCombosByStatus(status: Combo['status']): number
  countUsers(): number
  countUserCombos(login: string): number
  topPlugin(): Plugin | null
  latestAnnouncementId(): string | null

  /* ---- 写 ---- */
  toggleLike(userId: string, target: string): { count: number; liked: boolean }
  /** 把点赞计数应用到插件或组合（按目标类型自动判定）。 */
  applyLikeCount(target: string, count: number): void
  /** 风控：疑似刷赞先隔离（待确认不计入排行），复核后生效或清除。 */
  checkLikeRisk(userId: string, login: string, target: string, ip: string): string | null
  getRiskQueue(): StoredRiskLike[]
  queueRiskLike(input: { userId: string; login: string; target: string; ip: string; reason: string }): StoredRiskLike
  resolveRiskLike(id: number, action: 'include' | 'reject'): StoredRiskLike | null
  ensureLike(userId: string, target: string): void
  userRegisteredAt(login: string): string | null
  /** 匿名会话凭证：签发 / 校验（过期即失效）。 */
  mintAnonToken(instanceId: string): string
  verifyAnonToken(token: string): boolean
  /** 安装/下载计数：匿名凭证 + 1h 窗口去重 + 按天聚合产出 downloads_7d。 */
  recordInstall(token: string, target: string): { ok: boolean; counted: boolean; downloads_7d: number }
  createCombo(input: { name: string; description: string; members: string[]; author: string; authorGithub: string }): Combo
  /** 用户删除自己的组合（仅作者本人；返回是否删除成功）。 */
  removeCombo(id: string, login: string): boolean
  setComboStatus(id: string, status: Combo['status']): Combo | null
  /** 注销账号（v3.6 U2）：删除账号/点赞/云端清单；组合按选择删除或匿名保留（作者显示"已注销用户"）。 */
  deactivateUser(userId: string, login: string, combos: 'delete' | 'anonymize'): { ok: boolean; deleted: { likes: number; installs: number; combos: number } }
  replaceInstalls(userId: string, list: Array<{ target: string; type: 'plugin' | 'combo'; version: string }>): CloudInstall[]
  addAnnouncement(input: { version: string; level: 'info' | 'important'; content: string }): Announcement
  removeAnnouncement(id: string): boolean
  addReport(input: { pkg: string; repo_url: string | null; version: string }): StoredReport
  resolveReport(id: number, status: 'included' | 'invalid' | 'rejected'): StoredReport | null
  fastTrack(repoUrl: string): Plugin
  setPluginSecurity(id: string, security: Plugin['security']): void
  setUserStatus(id: string, status: User['status']): User | null
  setConfig(cfg: ServerConfig): void
  addBlocklist(pkg: string): void
  removeBlocklist(pkg: string): void
  setPluginBlocked(pkg: string, blocked: boolean): void
  addFedRelation(input: { peer_url: string; mode: 'snapshot' | 'realtime' }): FedRelation
  setFedRelationStatus(id: string, status: FedRelation['status']): FedRelation | null
  addFedMessage(input: { relation_id: string; body: string }): void
  setUpdateState(state: UpdateState): void
  log(actor: string, action: string, detail: Record<string, unknown>): void

  /* ---- 同步管线 ---- */
  syncTarget(): SyncTarget
  /** 同步管线落库（MemoryRepo 为 no-op，PgRepo 持久化插件与星数快照）。 */
  persistSync(): Promise<void>
}
