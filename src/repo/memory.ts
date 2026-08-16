import type { Announcement, Combo, ComboMember, Plugin, StarSnapshot, User } from '../shared/models.js'
import type { Delta, NodeInfo } from '../shared/protocol.js'
import { DEFAULT_CONFIG, type ServerConfig } from '../shared/config.js'
import type { AuditEntry, CloudInstall, FedMessage, FedRelation, StoredLike, StoredReport, StoredRiskLike, UpdateState } from './data.js'
import type { Repo } from './types.js'
import type { SyncTarget } from '../sync/github.js'

export type { StoredLike, StoredReport, CloudInstall, FedRelation, FedMessage, UpdateState, AuditEntry } from './data.js'

const RAW_PLUGINS: Array<[string, string, number, number, number, 'official' | 'community', number]> = [
  ['dsh-memory', '为 Agent 提供持久化记忆与跨会话召回，支持本地向量存储，开箱即用。', 2841, 213, 96, 'official', 1],
  ['dsh-web-ui', '第三方增强 Web 界面：任务面板、Git 图、文件树预览一网打尽。', 2312, 187, 121, 'community', 0],
  ['dsh-cc-tui', 'Claude Code 风格全屏终端 UI，npm 一键安装，键盘党福音。', 1976, 164, 58, 'community', 0],
  ['dsh-browser-panel', '内嵌浏览器面板，让 Agent 边看网页边操作，支持截图回传。', 1654, 142, 77, 'community', 0],
  ['dsh-checkpoint', '会话检查点与一键回滚，Agent 改崩了也能秒级恢复现场。', 1522, 121, 64, 'official', 0],
  ['dsh-deep-research', '多步深度研究插件：自动检索、交叉验证、输出带引用的报告。', 1387, 118, 83, 'community', 1],
  ['dsh-vision', '为纯文本模型补上眼睛：OCR、图像问答、UI 截图理解。', 1290, 102, 45, 'community', 0],
  ['dsh-session-search', '全文检索历史会话，按工具调用/文件/错误信息精准定位。', 1108, 97, 39, 'community', 0],
  ['dsh-skins', 'WebUI 换肤中心，十余套主题一键切换，支持自定义 CSS。', 987, 88, 52, 'community', 0],
  ['dsh-tool-regex', '零依赖正则工具箱：匹配、替换、提取，附带常用规则库。', 876, 79, 31, 'community', 0],
  ['dsh-pet', '桌面宠物常驻 WebUI 角落，会随任务进度做表情，摸鱼伴侣。', 812, 74, 66, 'community', 0],
  ['dsh-auto-chess', '自走棋小游戏插件，跑长任务时来一局，内置排行榜。', 764, 69, 88, 'community', 0],
  ['dsh-data-agent', '连接数据库/CSV 的数据分析 Agent 技能包，自动生成图表。', 701, 63, 42, 'community', 0],
  ['dsh-a2a', 'Agent 网格通信协议实现，多 Agent 协同编排的基础设施。', 655, 57, 25, 'official', 0],
  ['dsh-rewind', '时间旅行调试：回放任意一步上下文注入，精确定位幻觉来源。', 598, 52, 34, 'community', 0],
  ['dsh-kimi-browser', 'Kimi 浏览器自动化桥接，网页抓取与表单填写一气呵成。', 540, 47, 29, 'community', 0],
  ['dsh-tool-diff', '文件/目录差异对比工具，支持语法高亮与三方合并视图。', 489, 41, 18, 'community', 0],
  ['dsh-session-hub', '会话共享中心：把一次成功的 Agent 轨迹分享给团队复用。', 431, 36, 22, 'community', 0],
  ['dsh-tool-encoding', '编码探测与转换全家桶，GBK/UTF-8/BOM 问题一键解决。', 388, 31, 15, 'community', 0],
  ['dsh-gomoku', '五子棋人机对战插件，内置三种难度，支持让子。', 342, 27, 49, 'community', 0],
]

const RAW_COMBOS: Array<[string, string, string[], number, number, string]> = [
  ['新手启航包', '刚装 dsh 闭眼入：记忆 + 检查点 + 会话搜索，日常开发三件套。', ['dsh-memory', 'dsh-checkpoint', 'dsh-session-search'], 486, 1203, 'liwei'],
  ['前端摸鱼套装', '增强界面 + 换肤 + 桌宠，让你的 dsh 好看又好玩。', ['dsh-web-ui', 'dsh-skins', 'dsh-pet'], 352, 891, 'xiaoyu'],
  ['深度研究工位', '检索、浏览、出报告一条龙，调研类任务直接起飞。', ['dsh-deep-research', 'dsh-browser-panel', 'dsh-data-agent'], 297, 764, 'datasci_hao'],
  ['终端极客包', 'TUI + 正则 + diff + 编码，纯键盘流的全套装备。', ['dsh-cc-tui', 'dsh-tool-regex', 'dsh-tool-diff', 'dsh-tool-encoding'], 188, 502, 'vim_rock'],
]

const RAW_ANNOS: Array<[string, string, 'info' | 'important', string, string]> = [
  ['v0.3.0', 'imp', 'important', '新增「今日星增 Top 20」趋势榜；面板支持拖拽缩放与明暗主题；非 WebUI 环境新增地址模式。', '2026-08-14'],
  ['v0.2.1', 'inf', 'info', '修复组合安装时版本锁定的边界问题；本地索引构建提速约 40%。', '2026-08-10'],
  ['v1.1-m', 'inf', 'info', '【mirror-01.cn】节点公告：本周六凌晨例行维护，期间可自动切换至官方源，数据无差别。', '2026-08-12'],
  ['v0.2.0', 'inf', 'info', '组合功能上线：创建、一键安装、点赞；每用户上限 3 个组合。', '2026-08-05'],
]

/**
 * 内存仓库：无凭据阶段用假数据跑通全链路；接 PostgreSQL 后替换为 PgRepo（同接口）。
 */
export class MemoryRepo implements Repo {
  plugins: Plugin[] = []
  combos: Combo[] = []
  announcements: Announcement[] = []
  likes: StoredLike[] = []
  reports: StoredReport[] = []
  users: User[] = []
  installs: CloudInstall[] = []
  nodes: NodeInfo[] = []
  fedRelations: FedRelation[] = []
  fedMessages: FedMessage[] = []
  audit: AuditEntry[] = []
  blocklist: string[] = []
  starSnapshots: StarSnapshot[] = []
  config: ServerConfig = structuredClone(DEFAULT_CONFIG)
  pluginsRevision = 1
  combosRevision = 1
  private anonTokens = new Map<string, { instanceId: string; expiresAt: number }>()
  private installWindows = new Map<string, number>()
  private dailyDownloads = new Map<string, number>()
  riskQueue: StoredRiskLike[] = []
  riskSeq = 0
  private likeTrail: Array<{ userId: string; target: string; ip: string; at: number }> = []
  updateState: UpdateState = {
    stage: 'idle',
    from_version: 'v0.3.2',
    to_version: '',
    log: [],
    error: null,
    started_by: '',
    started_at: '',
    finished_at: null,
    progress_pct: 0,
    message: '待命',
  }

  /**
   * @param seedDemo 是否注入演示假数据。仅纯离线演示模式（无 token 且未配置 OAuth）时为 true；
   * 生产/联调模式（有 GitHub token 或 OAuth 凭据）下为 false，避免测试残留混入真实数据。
   */
  constructor(seedDemo = true) {
    if (seedDemo) this.seed()
  }

  private seed(): void {
    // 演示数据的作者与安装 spec（正式同步数据来自 GitHub 提取管线，不经过这里）
    const DEMO_AUTHORS: Record<string, string> = {
      'dsh-memory': 'liwei', 'dsh-web-ui': 'xiaoyu', 'dsh-cc-tui': 'vim_rock', 'dsh-browser-panel': 'datasci_hao',
      'dsh-checkpoint': 'liwei', 'dsh-deep-research': 'datasci_hao', 'dsh-vision': 'xiaoyu', 'dsh-session-search': 'liwei',
      'dsh-skins': 'xiaoyu', 'dsh-tool-regex': 'vim_rock', 'dsh-pet': 'xiaoyu', 'dsh-auto-chess': 'gamer_wang',
      'dsh-data-agent': 'datasci_hao', 'dsh-a2a': 'liwei', 'dsh-rewind': 'liwei', 'dsh-kimi-browser': 'datasci_hao',
      'dsh-tool-diff': 'vim_rock', 'dsh-session-hub': 'liwei', 'dsh-tool-encoding': 'vim_rock', 'dsh-gomoku': 'gamer_wang',
    }
    this.plugins = RAW_PLUGINS.map(([id, description, stars, stars_delta_day, likes, source, isNew], i) => ({
      id,
      kind: 'plugin' as const,
      version: i === 0 ? '0.4.0' : '1.0.0',
      name: id,
      description,
      repo: `dsh-store/${id}`,
      repo_url: `https://github.com/dsh-store/${id}`,
      source,
      stars,
      stars_delta_day,
      stars_delta_7d: Math.round(stars_delta_day * 4.6),
      trending_rank: i < 20 ? i + 1 : null,
      likes,
      downloads_7d: Math.round(stars * 0.31),
      quality_score: Math.max(38, 92 - i * 3),
      tags: [],
      compat: 'dsh ≥0.1.0-rc.5',
      author: DEMO_AUTHORS[id] ?? '社区',
      install: `github:dsh-store/${id}`,
      is_new: isNew === 1,
      security: { level: 2, score: 90 + (i % 10), risk_tags: [], blocked: false },
      status: 'listed',
      updated_at: '2026-08-14T00:00:00Z',
    }))
    // Agent（Preset）演示数据：文件复制安装，单独页面展示
    this.plugins.push(
      {
        id: 'creator-agent',
        kind: 'preset',
        preset_name: 'creator',
        version: '1.0.0',
        name: '创造模式 Agent',
        description: '以创作者视角组织的 Agent 预设：包含创作工作流、灵感管理与发布流程。安装后重启 DSH，在新建空白会话时选择 creator 预设。',
        repo: 'dsh-store/creator-agent',
        repo_url: 'https://github.com/dsh-store/creator-agent',
        author: 'liwei',
        source: 'community',
        stars: 1388,
        stars_delta_day: 55,
        stars_delta_7d: 253,
        trending_rank: null,
        likes: 42,
        downloads_7d: 331,
        quality_score: 88,
        tags: ['agent', 'preset'],
        compat: 'DSH 预设（重启后新建空白会话选择）',
        install: 'preset:creator',
        is_new: false,
        security: { level: 0, score: 95, risk_tags: [], blocked: false },
        status: 'listed',
        updated_at: '2026-08-14T00:00:00Z',
      },
      {
        id: 'minimal-agent',
        kind: 'preset',
        preset_name: 'minimal',
        version: '1.0.0',
        name: '极简模式 Agent',
        description: '只挂载最基础的模型与工具，适合快速问答和轻量任务。复制到 .agent-presets/minimal 后重启 DSH 生效。',
        repo: 'dsh-store/minimal-agent',
        repo_url: 'https://github.com/dsh-store/minimal-agent',
        author: 'xiaoyu',
        source: 'community',
        stars: 764,
        stars_delta_day: 28,
        stars_delta_7d: 129,
        trending_rank: null,
        likes: 19,
        downloads_7d: 208,
        quality_score: 82,
        tags: ['agent', 'preset'],
        compat: 'DSH 预设（重启后新建空白会话选择）',
        install: 'preset:minimal',
        is_new: false,
        security: { level: 0, score: 96, risk_tags: [], blocked: false },
        status: 'listed',
        updated_at: '2026-08-14T00:00:00Z',
      },
    )

    this.combos = RAW_COMBOS.map(([name, description, members, likes, downloads_7d, author], i) => ({
      id: `store.example.com:combo_${i + 1}`,
      slug: name,
      name,
      description,
      members: members.map((pkg) => ({ pkg, version: '*', install_mode: 'auto' as const })),
      author,
      author_github: author,
      likes,
      downloads_7d,
      status: 'published',
      origin_server: 'store.example.com',
      version: 1,
      updated_at: '2026-08-14T00:00:00Z',
    }))

    this.announcements = RAW_ANNOS.map(([version, _tag, level, content, published_at], i) => ({
      id: `ann_${i + 1}`,
      version,
      level,
      content,
      published_at,
      origin_server: i === 2 ? 'mirror-01.cn' : '官方源',
    }))

    this.users = [
      { id: 'u_liwei', github_id: 1001, login: 'liwei', name: '李伟', home_server: 'store.example.com', registered_at: '2026-08-13', combo_count: 2, status: 'active' },
      { id: 'u_xiaoyu', github_id: 1002, login: 'xiaoyu', name: '陈晓雨', home_server: 'store.example.com', registered_at: '2026-08-13', combo_count: 1, status: 'active' },
      { id: 'u_spammer', github_id: 1003, login: 'spammer99', name: null, home_server: 'store.example.com', registered_at: '2026-08-14', combo_count: 3, status: 'active' },
    ]

    this.likes = [
      { user_id: 'u_liwei', target: 'dsh-memory', at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-checkpoint', at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_xiaoyu', target: 'dsh-web-ui', at: '2026-08-14T00:00:00Z' },
    ]

    this.riskQueue = [
      { id: 1, user_id: 'u_spammer', login: 'spammer99', target: 'dsh-memory', ip: '203.0.113.7', reason: '同 IP 3 个账号在 30 分钟内集中点赞同一目标', status: 'pending', at: '2026-08-14T10:23:00Z' },
    ]
    this.riskSeq = 1
    this.baselineDailyDownloads()

    this.installs = [
      { user_id: 'u_liwei', target: 'dsh-memory', type: 'plugin', version: '0.3.1', source_combo_id: 'store.example.com:combo_1', at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-checkpoint', type: 'plugin', version: '1.2.0', source_combo_id: 'store.example.com:combo_1', at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-session-search', type: 'plugin', version: '0.9.4', source_combo_id: 'store.example.com:combo_1', at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-web-ui', type: 'plugin', version: '1.0.0', source_combo_id: null, at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-skins', type: 'plugin', version: '1.0.0', source_combo_id: null, at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: 'dsh-pet', type: 'plugin', version: '1.0.0', source_combo_id: null, at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: '新手启航包', type: 'combo', version: '1', source_combo_id: null, at: '2026-08-14T00:00:00Z' },
      { user_id: 'u_liwei', target: '前端摸鱼套装', type: 'combo', version: '1', source_combo_id: null, at: '2026-08-14T00:00:00Z' },
    ]

    this.reports = [
      { id: 1, pkg: 'my-local-tools', repo_url: 'github.com/liwei/my-local-tools', version: '0.1.0', reporter_id: null, status: 'pending', created_at: '2026-08-14' },
      { id: 2, pkg: 'inner-flow', repo_url: null, version: '0.2.0', reporter_id: null, status: 'pending', created_at: '2026-08-14' },
      { id: 3, pkg: 'team-ci-helper', repo_url: 'github.com/acme/team-ci-helper', version: '1.0.0', reporter_id: null, status: 'pending', created_at: '2026-08-13' },
    ]

    this.nodes = [
      { id: 'official', name: '官方源', url: 'store.example.com', rtt_ms: 18, healthy: true, is_lb: false },
      { id: 'mirror-01', name: 'mirror-01.cn', url: 'mirror-01.cn', rtt_ms: 12, healthy: true, is_lb: true },
      { id: 'mirror-02', name: 'mirror-02.cn', url: 'mirror-02.cn', rtt_ms: 23, healthy: true, is_lb: true },
    ]

    this.fedRelations = [
      { id: 'fed_1', peer_url: 'store-friend.com', status: 'connected', share: { combos: '实时', counts: '实时', security: '实时' }, mode: 'realtime', rtt_ms: 38, created_at: '2026-08-10' },
      { id: 'fed_2', peer_url: 'dsh-hub.example.org', status: 'pending', share: {}, mode: 'snapshot', rtt_ms: null, created_at: '2026-08-14' },
    ]
  }

  /* ---------------- delta ---------------- */

  pluginsDelta(since?: string): Delta<Plugin> {
    if (since === String(this.pluginsRevision)) {
      return { revision: String(this.pluginsRevision), items: [], full: false, tombstones: [] }
    }
    return { revision: String(this.pluginsRevision), items: this.plugins, full: true, tombstones: [] }
  }

  combosDelta(since?: string): Delta<Combo> {
    if (since === String(this.combosRevision)) {
      return { revision: String(this.combosRevision), items: [], full: false, tombstones: [] }
    }
    return { revision: String(this.combosRevision), items: this.combos, full: true, tombstones: [] }
  }

  /* ---------------- likes ---------------- */

  likeCount(target: string): number {
    return this.likes.filter((l) => l.target === target).length
  }

  getUserLikes(userId: string): string[] {
    return this.likes.filter((l) => l.user_id === userId).map((l) => l.target)
  }

  toggleLike(userId: string, target: string): { count: number; liked: boolean } {
    const existing = this.likes.findIndex((l) => l.user_id === userId && l.target === target)
    if (existing >= 0) {
      this.likes.splice(existing, 1)
      return { count: this.likeCount(target), liked: false }
    }
    this.likes.push({ user_id: userId, target, at: new Date().toISOString() })
    return { count: this.likeCount(target), liked: true }
  }

  /* ---------------- combos ---------------- */

  /** 兼容两种成员形态：字符串包名（全 auto）或 {pkg, install_mode} 对象。 */
  private static normMembers(members: Array<string | { pkg: string; install_mode?: 'auto' | 'manual' }>): ComboMember[] {
    return members.map((m) =>
      typeof m === 'string'
        ? { pkg: m, version: '*', install_mode: 'auto' as const }
        : { pkg: String(m.pkg), version: '*', install_mode: m.install_mode === 'manual' ? 'manual' as const : 'auto' as const },
    )
  }

  createCombo(input: { name: string; description: string; members: Array<string | { pkg: string; install_mode?: 'auto' | 'manual' }>; author: string; authorGithub: string }): Combo {
    // id 加随机后缀：同一毫秒创建多个组合时避免主键冲突
    const combo: Combo = {
      id: `store.example.com:combo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      slug: input.name,
      name: input.name,
      description: input.description,
      members: MemoryRepo.normMembers(input.members),
      author: input.author,
      author_github: input.authorGithub,
      likes: 0,
      downloads_7d: 0,
      status: 'pending',
      origin_server: 'store.example.com',
      version: 1,
      updated_at: new Date().toISOString(),
    }
    this.combos.push(combo)
    this.combosRevision++
    return combo
  }

  /** 作者编辑组合（名称/描述/成员）；返回更新后的组合；不存在或非作者返回 null。 */
  updateCombo(id: string, login: string, input: { name: string; description: string; members: Array<string | { pkg: string; install_mode?: 'auto' | 'manual' }> }): Combo | null {
    const c = this.combos.find((x) => x.id === id && x.author === login)
    if (!c) return null
    c.name = input.name
    c.slug = input.name
    c.description = input.description
    c.members = MemoryRepo.normMembers(input.members)
    c.version++
    c.updated_at = new Date().toISOString()
    this.combosRevision++
    return c
  }

  removeCombo(id: string, login: string): boolean {
    const idx = this.combos.findIndex((x) => x.id === id && x.author === login)
    if (idx < 0) return false
    this.combos.splice(idx, 1)
    this.combosRevision++
    return true
  }

  setComboStatus(id: string, status: Combo['status']): Combo | null {
    const c = this.combos.find((x) => x.id === id)
    if (!c) return null
    c.status = status
    c.updated_at = new Date().toISOString()
    this.combosRevision++
    return c
  }

  /* ---------------- announcements ---------------- */

  addAnnouncement(input: { version: string; level: 'info' | 'important'; content: string; user_id?: string | null }): Announcement {
    const a: Announcement = {
      id: `ann_${Date.now()}`,
      version: input.version,
      level: input.level,
      content: input.content,
      published_at: new Date().toISOString().slice(0, 10),
      origin_server: '官方源',
      user_id: input.user_id ?? null,
    }
    this.announcements.unshift(a)
    return a
  }

  removeAnnouncement(id: string): boolean {
    const before = this.announcements.length
    this.announcements = this.announcements.filter((a) => a.id !== id)
    return this.announcements.length < before
  }

  /* ---------------- reports ---------------- */

  addReport(input: { pkg: string; repo_url: string | null; version: string }): StoredReport {
    const r: StoredReport = {
      id: this.reports.length + 1,
      pkg: input.pkg,
      repo_url: input.repo_url,
      version: input.version,
      reporter_id: null,
      status: 'pending',
      created_at: new Date().toISOString().slice(0, 10),
    }
    this.reports.push(r)
    return r
  }

  resolveReport(id: number, status: 'included' | 'invalid' | 'rejected'): StoredReport | null {
    const r = this.reports.find((x) => x.id === id)
    if (!r) return null
    r.status = status
    return r
  }

  /** 提速收录：单条触发提取管线（mock 提取），分钟级入库。 */
  fastTrack(repoUrl: string): Plugin {
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/)
    const id = m ? m[2] : `fast_${Date.now()}`
    const plugin: Plugin = {
      id,
      kind: 'plugin',
      version: '1.0.0',
      name: id,
      description: '（提速收录 · 提取管线产出）',
      repo: m ? `${m[1]}/${m[2]}` : id,
      repo_url: repoUrl,
      source: 'community',
      stars: 0,
      stars_delta_day: 0,
      stars_delta_7d: 0,
      trending_rank: null,
      likes: 0,
      downloads_7d: 0,
      quality_score: 60,
      tags: [],
      compat: 'dsh ≥0.1.0-rc.5',
      is_new: true,
      security: { level: 2, score: 80, risk_tags: [], blocked: false },
      status: 'listed',
      updated_at: new Date().toISOString(),
    }
    this.plugins.push(plugin)
    this.pluginsRevision++
    return plugin
  }

  /* ---------------- anon tokens ---------------- */

  mintAnonToken(instanceId: string): string {
    const token = `anon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    this.anonTokens.set(token, { instanceId, expiresAt: Date.now() + this.config.anon.token_ttl * 1000 })
    return token
  }

  verifyAnonToken(token: string): boolean {
    const rec = this.anonTokens.get(token)
    return !!rec && rec.expiresAt > Date.now()
  }

  /* ---------------- 安装/下载计数（v3.2 S8：凭证门槛 + 1h 窗口去重 + 按天聚合） ---------------- */

  recordInstall(token: string, target: string): { ok: boolean; counted: boolean; downloads_7d: number } {
    const p = this.plugins.find((x) => x.id === target)
    const c = this.combos.find((x) => x.id === target)
    if (!p && !c) return { ok: false, counted: false, downloads_7d: 0 }
    const now = Date.now()
    const key = `${token}|${target}`
    const last = this.installWindows.get(key) ?? 0
    if (now - last < 3600_000) {
      return { ok: true, counted: false, downloads_7d: this.downloads7d(target) }
    }
    this.installWindows.set(key, now)
    if (this.installWindows.size > 5000) this.installWindows.clear()
    const day = new Date().toISOString().slice(0, 10)
    const dk = `${target}|${day}`
    this.dailyDownloads.set(dk, (this.dailyDownloads.get(dk) ?? 0) + 1)
    const total = this.downloads7d(target)
    this.applyDownloads(target, total)
    return { ok: true, counted: true, downloads_7d: total }
  }

  private downloads7d(target: string): number {
    let sum = 0
    const now = Date.now()
    for (let i = 0; i < 7; i++) {
      const d = new Date(now - i * 86400_000).toISOString().slice(0, 10)
      sum += this.dailyDownloads.get(`${target}|${d}`) ?? 0
    }
    return sum
  }

  /**
   * 把已持久化的 downloads_7d 折算进当日聚合基线：
   * 种子注入 / PostgreSQL 重启加载后调用，避免事件重算把存量计数清零。
   */
  protected baselineDailyDownloads(): void {
    const today = new Date().toISOString().slice(0, 10)
    for (const p of this.plugins) this.dailyDownloads.set(`${p.id}|${today}`, p.downloads_7d)
    for (const c of this.combos) this.dailyDownloads.set(`${c.id}|${today}`, c.downloads_7d)
  }

  private applyDownloads(target: string, total: number): void {
    const p = this.plugins.find((x) => x.id === target)
    if (p) {
      p.downloads_7d = total
      this.pluginsRevision++
    } else {
      const c = this.combos.find((x) => x.id === target)
      if (c) {
        c.downloads_7d = total
        this.combosRevision++
      }
    }
  }

  /* ---------------- 风控（v3.2 S8：疑似刷赞先隔离，复核后生效或清除） ---------------- */

  getRiskQueue(): StoredRiskLike[] {
    return this.riskQueue
  }

  userRegisteredAt(login: string): string | null {
    return this.users.find((u) => u.login === login)?.registered_at ?? null
  }

  registerUser(input: { login: string; name: string | null; githubId: number; homeServer: string }): User {
    const existing = this.users.find((u) => u.github_id === input.githubId)
    if (existing) {
      // GitHub 用户可能改名/改昵称：以 github_id 为准保持同一账号，刷新资料
      existing.login = input.login
      existing.name = input.name
      existing.home_server = input.homeServer
      return existing
    }
    const u: User = {
      id: `u_${input.login}`,
      github_id: input.githubId,
      login: input.login,
      name: input.name,
      home_server: input.homeServer,
      registered_at: new Date().toISOString().slice(0, 10),
      combo_count: 0,
      status: 'active',
    }
    this.users.push(u)
    return u
  }

  checkLikeRisk(userId: string, login: string, target: string, ip: string): string | null {
    const now = Date.now()
    const risk = this.config.risk
    // ① 注册即赞
    const registered = this.userRegisteredAt(login)
    if (registered) {
      const age = now - new Date(registered).getTime()
      if (age >= 0 && age < risk.like_new_account_min * 60_000) {
        this.likeTrail.push({ userId, target, ip, at: now })
        return `注册后 ${risk.like_new_account_min} 分钟内点赞，疑似注册即赞`
      }
    }
    // ② 同 IP 多账号集中点赞同一目标
    const ipWindow = risk.like_same_ip_window_min * 60_000
    const peers = new Set<string>()
    for (const t of this.likeTrail) {
      if (t.target === target && t.ip === ip && t.userId !== userId && now - t.at <= ipWindow) peers.add(t.userId)
    }
    if (peers.size + 1 >= risk.like_same_ip_accounts) {
      this.likeTrail.push({ userId, target, ip, at: now })
      return `同 IP ${peers.size + 1} 个账号在 ${risk.like_same_ip_window_min} 分钟内集中点赞同一目标，疑似刷赞`
    }
    // ③ 高频切换点赞
    const tgWindow = risk.like_toggle_window_min * 60_000
    const toggles = this.likeTrail.filter((t) => t.userId === userId && t.target === target && now - t.at <= tgWindow).length
    if (toggles + 1 >= risk.like_toggle_count) {
      this.likeTrail.push({ userId, target, ip, at: now })
      return `同一账号 ${risk.like_toggle_window_min} 分钟内高频切换点赞，疑似刷量`
    }
    this.likeTrail.push({ userId, target, ip, at: now })
    if (this.likeTrail.length > 500) this.likeTrail = this.likeTrail.filter((t) => now - t.at <= 3600_000)
    return null
  }

  queueRiskLike(input: { userId: string; login: string; target: string; ip: string; reason: string }): StoredRiskLike {
    const item: StoredRiskLike = {
      id: ++this.riskSeq,
      user_id: input.userId,
      login: input.login,
      target: input.target,
      ip: input.ip,
      reason: input.reason,
      status: 'pending',
      at: new Date().toISOString(),
    }
    this.riskQueue.push(item)
    return item
  }

  ensureLike(userId: string, target: string): void {
    if (!this.likes.some((l) => l.user_id === userId && l.target === target)) {
      this.likes.push({ user_id: userId, target, at: new Date().toISOString() })
    }
  }

  resolveRiskLike(id: number, action: 'include' | 'reject'): StoredRiskLike | null {
    const item = this.riskQueue.find((r) => r.id === id)
    if (!item) return null
    if (item.status === 'pending') {
      if (action === 'include') {
        this.ensureLike(item.user_id, item.target)
        this.applyLikeCount(item.target, this.likeCount(item.target))
      }
      item.status = action === 'include' ? 'included' : 'rejected'
    }
    return item
  }

  /* ---------------- audit ---------------- */

  log(actor: string, action: string, detail: Record<string, unknown>): void {
    this.audit.push({ actor, action, detail, created_at: new Date().toISOString() })
  }

  /* ---------------- 接口读方法 ---------------- */

  getPlugins(): Plugin[] {
    return this.plugins
  }
  getCombos(): Combo[] {
    return this.combos
  }
  getAnnouncements(): Announcement[] {
    return this.announcements
  }
  getNodes(): NodeInfo[] {
    return this.nodes
  }
  getUsers(): User[] {
    return this.users
  }
  getReports(): StoredReport[] {
    return this.reports
  }
  getLikes(): StoredLike[] {
    return this.likes
  }
  installsOf(userId: string): CloudInstall[] {
    return this.installs.filter((i) => i.user_id === userId)
  }
  getFedRelations(): FedRelation[] {
    return this.fedRelations
  }
  getFedMessages(): FedMessage[] {
    return this.fedMessages
  }
  getBlocklist(): string[] {
    return this.blocklist
  }
  getConfig(): ServerConfig {
    return this.config
  }
  getUpdateState(): UpdateState {
    return this.updateState
  }
  getPluginsRevision(): number {
    return this.pluginsRevision
  }
  getCombosRevision(): number {
    return this.combosRevision
  }
  countPlugins(): number {
    return this.plugins.length
  }
  countBlocked(): number {
    return this.blocklist.length
  }
  countCombosByStatus(status: Combo['status']): number {
    return this.combos.filter((c) => c.status === status).length
  }
  countUsers(): number {
    return this.users.length
  }
  countUserCombos(login: string): number {
    return this.combos.filter((c) => c.author === login && c.status !== 'removed').length
  }
  topPlugin(): Plugin | null {
    return this.plugins[0] ?? null
  }
  latestAnnouncementId(): string | null {
    return this.announcements[0]?.id ?? null
  }

  /* ---------------- 接口写方法 ---------------- */

  applyLikeCount(target: string, count: number): void {
    const p = this.plugins.find((x) => x.id === target)
    if (p) {
      p.likes = count
      this.pluginsRevision++
    } else {
      const c = this.combos.find((x) => x.id === target)
      if (c) {
        c.likes = count
        this.combosRevision++
      }
    }
  }

  replaceInstalls(userId: string, list: Array<{ target: string; type: 'plugin' | 'combo'; version: string }>): CloudInstall[] {
    this.installs = this.installs.filter((i) => i.user_id !== userId)
    for (const it of list) {
      this.installs.push({ user_id: userId, target: it.target, type: it.type, version: it.version, source_combo_id: null, at: new Date().toISOString() })
    }
    return this.installsOf(userId)
  }

  deactivateUser(userId: string, login: string, combos: 'delete' | 'anonymize'): { ok: boolean; deleted: { likes: number; installs: number; combos: number } } {
    // 点赞：全部删除并回退计数（避免排行残留幽灵赞）
    const myLikes = this.likes.filter((l) => l.user_id === userId)
    const affected = new Set(myLikes.map((l) => l.target))
    this.likes = this.likes.filter((l) => l.user_id !== userId)
    for (const t of affected) this.applyLikeCount(t, this.likeCount(t))
    // 云端安装清单
    const myInstalls = this.installs.filter((i) => i.user_id === userId)
    this.installs = this.installs.filter((i) => i.user_id !== userId)
    // 组合：删除或匿名保留
    const mine = this.combos.filter((c) => c.author === login && c.status !== 'removed')
    if (combos === 'delete') {
      this.combos = this.combos.filter((c) => c.author !== login)
    } else {
      for (const c of mine) {
        c.author = '已注销用户'
        c.author_github = null
      }
    }
    this.combosRevision++
    // 墓碑：不物理删除用户行,置 deactivated。否则 JWT 仍有效时 currentUser 懒注册
    // 会把注销用户重新注册为 active（复活漏洞）；保留行也便于管理端审计注销记录。
    const u = this.users.find((x) => x.id === userId)
    if (u) u.status = 'deactivated'
    return { ok: true, deleted: { likes: myLikes.length, installs: myInstalls.length, combos: mine.length } }
  }

  setPluginSecurity(id: string, security: Plugin['security']): void {
    const p = this.plugins.find((x) => x.id === id)
    if (p) {
      p.security = security
      this.pluginsRevision++
    }
  }

  setUserStatus(id: string, status: User['status']): User | null {
    const u = this.users.find((x) => x.id === id)
    if (u) u.status = status
    return u ?? null
  }

  setConfig(cfg: ServerConfig): void {
    this.config = cfg
  }

  addBlocklist(pkg: string): void {
    if (!this.blocklist.includes(pkg)) this.blocklist.push(pkg)
  }

  removeBlocklist(pkg: string): void {
    this.blocklist = this.blocklist.filter((x) => x !== pkg)
  }

  setPluginBlocked(pkg: string, blocked: boolean): void {
    const p = this.plugins.find((x) => x.id === pkg)
    if (p) {
      p.security.blocked = blocked
      p.status = blocked ? 'blocked' : 'listed'
      this.pluginsRevision++
    }
  }

  addFedRelation(input: { peer_url: string; mode: 'snapshot' | 'realtime' }): FedRelation {
    const r: FedRelation = {
      id: `fed_${Date.now()}`,
      peer_url: input.peer_url,
      status: 'pending',
      share: {},
      mode: input.mode,
      rtt_ms: null,
      created_at: new Date().toISOString().slice(0, 10),
    }
    this.fedRelations.push(r)
    return r
  }

  setFedRelationStatus(id: string, status: FedRelation['status']): FedRelation | null {
    const r = this.fedRelations.find((x) => x.id === id)
    if (r) r.status = status
    return r ?? null
  }

  addFedMessage(input: { relation_id: string; body: string }): void {
    this.fedMessages.push({ id: this.fedMessages.length + 1, relation_id: input.relation_id, direction: 'out', body: input.body, created_at: new Date().toISOString() })
  }

  setUpdateState(state: UpdateState): void {
    this.updateState = state
  }

  /* ---------------- 同步管线 ---------------- */

  syncTarget(): SyncTarget {
    return {
      plugins: this.plugins,
      starSnapshots: this.starSnapshots,
      bumpPluginsRevision: () => {
        this.pluginsRevision++
      },
      log: (actor, action, detail) => this.log(actor, action, detail),
    }
  }

  async persistSync(): Promise<void> {
    // 内存仓库无需持久化
  }
}
