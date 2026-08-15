/**
 * 领域数据模型。字段对齐设计文档 v3~v3.7 的数据通道与双指标分离原则。
 */

/* ---------------- 插件 ---------------- */

export type PluginSource = 'official' | 'community'

export type PluginStatus = 'listed' | 'blocked' | 'needs_review' | 'pending'

/** 可安装物类型：Plugin 走 dsh plugin add；Preset 走文件复制到 .agent-presets。 */
export type InstallKind = 'plugin' | 'preset'

/** 风险标签（v3.1 S1 安全扫描管线产出）。 */
export type RiskTag =
  | 'has_install_script'
  | 'has_native_binary'
  | 'obfuscated'
  | 'suspicious_network'
  | 'reads_secret_env'
  | 'known_vuln_dep'

export interface SecurityProfile {
  /** 已通过的最高扫描层：0=元数据信誉 1=包级静态 2=代码模式 3=动态沙箱。 */
  level: 0 | 1 | 2 | 3
  /** 0~100 安全分。 */
  score: number
  risk_tags: RiskTag[]
  /** 唯一硬阻断：已拉黑（客户端安装器强制拦截）。 */
  blocked: boolean
}

/**
 * 插件条目（数据通道下发）。
 *
 * 双指标分离（硬规则）：`stars`(GitHub) 与 `likes`(本站) 永不合并/换算。
 */
export interface Plugin {
  /** 包名，如 "dsh-memory"。 */
  id: string
  /** 可安装物类型：插件 / 预设。 */
  kind: InstallKind
  /** Preset 的目录名（kind=preset 或双形态仓库时存在），安装 = 复制到 ~/.dsh/.agent-presets/<preset_name>。 */
  preset_name?: string
  /** 最新版本号（数据通道下发，供本地更新检测比对）。 */
  version: string
  name: string
  /** 提取管线产出的简介（2 行截断）。 */
  description: string
  /** owner/repo 全名（天然全局唯一，联邦去重键）。 */
  repo: string
  repo_url: string
  /** 作者（GitHub 仓库 owner）。 */
  author?: string
  source: PluginSource
  /** GitHub 星数（只读镜像，点击跳 GitHub）。 */
  stars: number
  /** 日增星数（当日快照 − 前一快照；新收录首日标记 new 不参与排行）。 */
  stars_delta_day: number
  /** 趋势榜名次（1~trending_size，不在榜内为 null）。 */
  trending_rank: number | null
  /** 本站点赞（登录后互动）。 */
  likes: number
  /** 近 7 天滚动下载量。 */
  downloads_7d: number
  /** 质量分 0~100。 */
  quality_score: number
  tags: string[]
  /** 兼容版本声明，如 "dsh >=0.1.0-rc.5"。 */
  compat: string
  /** 安装 spec：npm 包名（如 "dsh-memory"）或 git 形式（如 "github:owner/repo"）。
   *  客户端安装 = `dsh plugin add <install>`（可锁版本 add <install>@<version>）。 */
  install?: string
  /** 新收录首日标记（不参与增量排行，仅展示 🆕）。 */
  is_new: boolean
  security: SecurityProfile
  status: PluginStatus
  updated_at: string
}

/* ---------------- 组合 ---------------- */

export type ComboStatus = 'pending' | 'published' | 'removed'

export interface ComboMember {
  /** 包名（弱引用）。 */
  pkg: string
  /** 锁定的版本；'*' = 跟随最新。 */
  version: string
}

export interface Combo {
  /** 联邦限定 id：`{源域名}:{本地ID}`，防命名冲突。 */
  id: string
  slug: string
  name: string
  description: string
  members: ComboMember[]
  /** 展示名；注销用户显示"已注销用户"。 */
  author: string
  author_github: string | null
  likes: number
  downloads_7d: number
  status: ComboStatus
  /** 来源服务器域名（home 权威）。 */
  origin_server: string
  /** 副本同步版本号。 */
  version: number
  updated_at: string
}

/* ---------------- 服务器源 ---------------- */

export interface ServerSource {
  id: string
  name: string
  url: string
  /** 内置默认源（开箱即用）。 */
  builtin: boolean
  enabled: boolean
  /** 实测延迟。 */
  latency_ms: number | null
  /** 所属 LB 集群 id；null = 独立源。 */
  cluster_id: string | null
  /** 是否 LB 成员（设置页加 ⚖️ 徽标）。 */
  is_lb: boolean
  last_seen_at: string | null
  /** 客户端视角角色：主源 / 备用（主源制，同一时刻仅一个主源）。 */
  role?: 'primary' | 'backup'
  /** 连接状态：已连接 / 未连接 / 已断联。 */
  status?: 'connected' | 'disconnected' | 'unreachable'
}

/* ---------------- 公告 ---------------- */

export type AnnouncementLevel = 'info' | 'important'

export interface Announcement {
  id: string
  version: string
  level: AnnouncementLevel
  content: string
  published_at: string
  /** 发布服务器（LB 集群内公告按源分标签）。 */
  origin_server: string
  /** 管理端展示用。 */
  read_rate?: number
}

/* ---------------- 通知（客户端本地产出） ---------------- */

export type NotificationCategory = 'update' | 'pending' | 'system'

export interface NotificationAction {
  label: string
  /** primary 动作突出显示。 */
  primary?: boolean
  action: string
}

export interface NotificationItem {
  id: string
  category: NotificationCategory
  /** 图标 + 一句话说清"什么变了"。 */
  title: string
  /** 可点击定位的目标元素 id（"通知必带定位"硬要求）。 */
  target: string | null
  actions: NotificationAction[]
}

/* ---------------- 用户 / 账号 ---------------- */

export type UserStatus = 'active' | 'banned' | 'deactivated'

export interface User {
  id: string
  github_id: number
  login: string
  name: string | null
  /** home 服务器（联邦身份：资料永不复制到其他服）。 */
  home_server: string
  registered_at: string
  combo_count: number
  status: UserStatus
}

/* ---------------- 台账 / 云端清单 ---------------- */

/** 本地已安装台账记录（登录与否都在本地，v3.1 S2.1）。 */
export interface InstallRecord {
  pkg: string
  version: string
  installed_at: string
  /** 来源：组合安装 | 单独安装。 */
  source: 'combo' | 'single'
  combo_id: string | null
  restore_point_id: string | null
}

/** 还原点。 */
export interface RestorePoint {
  id: string
  created_at: string
  /** cordis.patch.yml + 版本清单快照。 */
  snapshot: unknown
}

/** 云端安装清单条目（登录用户专属，卸载即删）。 */
export interface CloudInstall {
  target: string
  type: 'plugin' | 'combo'
  version: string
  source_combo_id: string | null
  at: string
}

/* ---------------- 快照 / 统计 ---------------- */

export interface StarSnapshot {
  repo: string
  /** YYYY-MM-DD。 */
  date: string
  stars: number
}

export interface ServerStats {
  plugins_total: number
  plugins_blocked: number
  combos_published: number
  combos_pending: number
  users_registered: number
  today_new_users: number
  today_star_champion: string | null
  anon_devices_7d: number
  /** 风控队列待复核数（疑似刷赞，不计入排行）。 */
  risk_pending: number
}

export interface ServiceHealth {
  api_error_rate_1h: number
  github_sync: { at: string; changed: number; ok: boolean }
  token_pool: { used: number; total: number; pct: number }
  scan_queue: number
  disk: { used_gb: number; total_gb: number; pct: number }
  clock_drift_ms: number
}
