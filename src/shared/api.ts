/**
 * API 端点契约。所有路径与请求/响应类型集中于此，客户端与服务端共用。
 *
 * 命名约定：`/api/v1/...` 为公开/登录接口，`/federation/...` 为服务器间通道，
 * `/admin/...` 为管理端接口。
 */

export const API = {
  /** manifest 心跳（版本比对，变了才拉增量）。 */
  manifest: '/api/v1/manifest',
  /** 插件数据通道（?since= 增量，无 since 全量）。 */
  plugins: '/api/v1/plugins',
  /** 组数据通道（?since= 增量）。 */
  combos: '/api/v1/combos',
  /** 公告列表。 */
  announcements: '/api/v1/announcements',
  /** SSE 实时事件流（点赞/公告/插件库变更推送；EventSource 直连，跨源需 CORS）。 */
  events: '/api/v1/events',
  /** 联邦 / LB 节点与延迟表。 */
  nodes: '/api/v1/nodes',
  clusterNodes: '/api/v1/cluster/nodes',
  /** 匿名会话凭证（匿名写接口的唯一无登录入口）。 */
  anonToken: '/api/v1/anon-token',
  /** 安装/下载计数上报（匿名写：需 X-Anon-Token 凭证）。 */
  downloads: '/api/v1/downloads',
  /** 点赞 / 取消点赞（登录；疑似刷赞进风控队列）。 */
  like: '/api/v1/likes',
  /** 查询我点赞过的目标清单（登录；返回 target 字符串数组，插件包名或组合联邦 id）。 */
  meLikes: '/api/v1/me/likes',
  /** 创建组合（登录）。 */
  createCombo: '/api/v1/combos',
  /** 云端安装清单读写（登录）。 */
  meInstalls: '/api/v1/me/installs',
  /** 注销账号（登录；联动服务器清理点赞/云端清单/组合）。 */
  meDeactivate: '/api/v1/me/deactivate',
  /** 数据迁移（换源时提交本地数据，带预检响应）。 */
  meMigrate: '/api/v1/me/migrate',
  /** 库外插件上报（登录）。 */
  reportMissing: '/api/v1/reports/missing',
  /** 联邦握手（服务器间）。 */
  federationHandshake: '/api/v1/federation/handshake',
  /** 联邦增量拉取（服务器间）。 */
  federationChanges: '/api/v1/federation/changes',
  /** 服务器间站内信。 */
  federationMessage: '/federation/message',

  /* ---------- 管理端 ---------- */
  adminStats: '/admin/stats',
  adminHealth: '/admin/health',
  adminPlugins: '/admin/plugins',
  adminCombos: '/admin/combos',
  adminUsers: '/admin/users',
  adminReports: '/admin/reports',
  /** 风控队列（疑似刷赞待确认清单）。 */
  adminRiskQueue: '/admin/risk-queue',
  /** 提速收录（单条触发提取管线）。 */
  adminFastTrack: '/admin/fast-track',
  adminAnnouncements: '/admin/announcements',
  adminConfig: '/admin/config',
  adminBlocklist: '/admin/blocklist',
  adminFederation: '/admin/federation',
  /** 一键更新（最高权限操作，仅 role=admin）。 */
  adminUpdate: '/admin/update',
  adminUpdateStatus: '/admin/update/status',
} as const

/** 写接口（登录/凭证要求）。 */
export const WRITE_ENDPOINTS: readonly string[] = [
  API.like,
  API.downloads,
  API.createCombo,
  API.meInstalls,
  API.meDeactivate,
  API.meMigrate,
  API.reportMissing,
]

/* ---------------- 请求 / 响应类型 ---------------- */

/** 匿名会话凭证（v3.2 S8.3：无 token 的匿名写请求直接拒绝）。 */
export interface AnonTokenResponse {
  token: string
  expires_at: string
}

export interface LikeRequest {
  target: string
  value: 1 | -1
}

/** 安装/下载计数上报（匿名写，需 X-Anon-Token）。 */
export interface DownloadRequest {
  target: string
}

export interface DownloadResponse {
  target: string
  /** false = 同 token 同目标 1h 窗口内重复上报，未重复计数。 */
  counted: boolean
  downloads_7d: number
}

export interface CreateComboRequest {
  name: string
  description: string
  members: { pkg: string; version: string }[]
}

export interface ReportMissingRequest {
  pkg: string
  repo_url: string | null
  version: string
}

export interface MigrateRequest {
  /** 迁移的数据类别（组/点赞/收藏/订阅/云端清单）。 */
  groups?: unknown[]
  likes?: { target: string }[]
  installs?: CloudInstallLike[]
}

export interface CloudInstallLike {
  target: string
  type: 'plugin' | 'combo'
  version: string
}

/** 迁移预检响应：列出新源侧已存在的冲突项，交由用户选择。 */
export interface MigratePrecheck {
  conflicts: MigrateConflict[]
}

export interface MigrateConflict {
  kind: 'combo' | 'like' | 'install'
  target: string
  note: string
}

/** 联邦握手请求（发起方携带自身地址/公钥/拟共享清单）。 */
export interface FederationHandshakeRequest {
  from_url: string
  public_key: string
  share: FederationShare
}

export interface FederationShare {
  plugin_supplements: boolean
  combos: boolean
  counts: boolean
  trending: boolean
  security_intel: boolean
  mode: 'snapshot' | 'realtime'
}

export interface FastTrackRequest {
  repo_url: string
}

export interface UpdateRequest {
  /** 目标版本，白名单格式 ^v\d+\.\d+\.\d+。 */
  version: string
}

/** 一键更新流式状态。 */
export type UpdateStage =
  | 'idle'
  | 'fetching'
  | 'building'
  | 'migrating'
  | 'switching'
  | 'selfcheck'
  | 'done'
  | 'rolled_back'
  | 'failed'

export interface UpdateStatus {
  stage: UpdateStage
  from_version: string
  to_version: string
  log: string[]
  error: string | null
  started_by: string
  started_at: string
  finished_at: string | null
}
