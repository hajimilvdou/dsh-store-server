import type { Plugin, StarSnapshot } from '../shared/models.js'

/** 同步管线写入目标（MemoryRepo / PgRepo 均需满足此结构）。 */
export interface SyncTarget {
  plugins: Plugin[]
  starSnapshots: StarSnapshot[]
  bumpPluginsRevision(): void
  log(actor: string, action: string, detail: Record<string, unknown>): void
}

export interface SyncStatus {
  enabled: boolean
  tokens: number
  last_run_at: string | null
  last_result: string | null
  last_changed: number
  last_searched: number
  last_error: string | null
}

export type SyncStage = 'idle' | 'searching' | 'extracting' | 'trending' | 'done' | 'error'

/** 实时抓取进度：管理端横幅轮询展示。 */
export interface SyncProgress {
  running: boolean
  stage: SyncStage
  /** 人话阶段描述（搜索关键词 / 正在提取哪个仓库）。 */
  phase: string
  total: number
  done: number
  current: string | null
  changed: number
  started_at: string | null
  finished_at: string | null
  message: string | null
}

interface GhRepo {
  id: number
  full_name: string
  description: string | null
  stargazers_count: number
  html_url: string
  license: { spdx_id?: string } | null
  updated_at: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ReleaseInfo {
  tag: string | null
  name: string | null
  published_at: string | null
  body: string | null
}

/**
 * GitHub 同步管线（v3 §4 五级管线：抓取 → 解析 → 归一化 → 质量评分 → 人工覆盖）。
 * - 凭据（GITHUB_TOKENS，classic PAT）缺失时 enabled=false，runSync 直接跳过并记状态；
 * - token 池轮换；Search API 搜索指定 topic；README 抓取 + 简介提取；
 * - 星数每日快照 → 日增星数 → 趋势榜 Top N（新收录首日标记 new 不参与排行）。
 */
export class GithubSync {
  enabled: boolean
  readonly topic: string
  maxRepos: number
  status: SyncStatus
  progress: SyncProgress = {
    running: false,
    stage: 'idle',
    phase: '待命',
    total: 0,
    done: 0,
    current: null,
    changed: 0,
    started_at: null,
    finished_at: null,
    message: null,
  }
  private tokens: string[]
  private tokenIndex = 0
  private lastGhError: string | null = null
  private running: Promise<{ changed: number }> | null = null

  /** 星数区间拆分：单查询被 GitHub 1000 条硬上限截断时，逐段查询保证搜全。 */
  private static readonly STAR_SLICES = [
    'stars:>200',
    'stars:101..200',
    'stars:51..100',
    'stars:21..50',
    'stars:11..20',
    'stars:6..10',
    'stars:3..5',
    'stars:1..2',
    'stars:0',
  ]

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.tokens = (env.GITHUB_TOKENS ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    this.enabled = this.tokens.length > 0
    this.topic = env.SYNC_TOPIC?.trim() || 'dsh-plugin'
    // 0 = 全量搜完（星数区间拆分补齐）；>0 = 只收录前 N 个
    this.maxRepos = Math.max(0, Number(env.SYNC_MAX_REPOS ?? 0) || 0)
    this.status = {
      enabled: this.enabled,
      tokens: this.tokens.length,
      last_run_at: null,
      last_result: this.enabled ? null : '未配置 GITHUB_TOKENS',
      last_changed: 0,
      last_searched: 0,
      last_error: null,
    }
  }

  /** 配置中心热更新 token 池（数组或逗号分隔串；自动去空去重；清空即停用同步）。 */
  setTokens(raw: string[] | string): void {
    const wasEnabled = this.enabled
    const list = Array.isArray(raw) ? raw : String(raw).split(',')
    this.tokens = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))]
    this.tokenIndex = 0
    this.enabled = this.tokens.length > 0
    this.status.enabled = this.enabled
    this.status.tokens = this.tokens.length
    if (!this.enabled) {
      this.status.last_result = '未配置 GitHub 搜索 token（配置中心可填写）'
    } else if (!wasEnabled || this.status.last_result?.includes('未配置')) {
      // 从“未配置 → 已启用”时清掉旧文案，避免仪表盘出现“已启用 3 枚 token，结果却显示未配置”
      this.status.last_result = `已启用 ${this.tokens.length} 枚搜索 token，等待抓取任务`
      this.status.last_error = null
    }
  }

  /** 配置中心热更新抓取上限：0 = 服务器默认全量；>0 = 测试限量（如 100）。 */
  setMaxRepos(n: number): void {
    this.maxRepos = Math.max(0, Math.trunc(Number(n) || 0))
  }

  isRunning(): boolean {
    return this.progress.running || this.running !== null
  }

  private updateProgress(patch: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...patch }
  }

  /**
   * 手动触发后台抓取（管理端按钮）：立即返回进度，任务在后台完成；
   * 已在运行时重复点击直接返回当前进度，不会并发拉取。
   */
  startRun(target: SyncTarget): { started: boolean; progress: SyncProgress; done: Promise<{ changed: number }> } {
    if (this.isRunning()) return { started: false, progress: this.progress, done: this.running ?? Promise.resolve({ changed: 0 }) }
    this.progress = {
      running: true,
      stage: 'searching',
      phase: '正在搜索 GitHub 插件仓库…',
      total: 0,
      done: 0,
      current: null,
      changed: 0,
      started_at: new Date().toISOString(),
      finished_at: null,
      message: null,
    }
    const done = this.runSync(target).finally(() => {
      this.running = null
    })
    this.running = done
    return { started: true, progress: this.progress, done }
  }

  private gh(path: string, init?: RequestInit): Promise<Response | null> {
    const token = this.tokens[this.tokenIndex % this.tokens.length]
    this.tokenIndex++
    return fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-store-server', ...(init?.headers ?? {}) },
    })
      .then((r) => {
        if (r.ok) {
          this.lastGhError = null
          return r
        }
        this.lastGhError = `HTTP ${r.status}`
        return null
      })
      .catch((e: unknown) => {
        this.lastGhError = e instanceof Error ? e.message : String(e)
        return null
      })
  }

  /**
   * 单条搜索查询（翻页取全）。返回是否被 GitHub 1000 条上限截断（还有更多没拿到）。
   * 页间停顿 1.2s：搜索 API 限流 30 次/分钟（单 token）。
   */
  private async searchQuery(q: string, maxResults: number): Promise<{ items: GhRepo[]; truncated: boolean }> {
    const out: GhRepo[] = []
    const perPage = 100
    let truncated = false
    for (let page = 1; out.length < maxResults && page <= 10; page++) {
      const res = await this.gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`)
      if (!res) break
      const data = (await res.json().catch(() => null)) as { items?: GhRepo[] } | null
      const items = data?.items ?? []
      out.push(...items)
      if (items.length < perPage) break
      if (page === 10) truncated = true
      await sleep(1200)
    }
    return { items: out.slice(0, maxResults), truncated }
  }

  /**
   * 搜索规则（主搜 + 兜底 + 合并去重 + 星数区间补齐，搜完为止）：
   * - 主搜 topic 标签（最准、最多）；
   * - 兜底关键词（防止有人没打标签）；
   * - 按 full_name 去重；
   * - 若单查询被 GitHub 1000 条硬上限截断 → 按星数区间逐段查询补齐。
   */
  async searchRepos(): Promise<GhRepo[]> {
    if (!this.enabled) return []
    const seen = new Set<string>()
    const merged: GhRepo[] = []
    const push = (list: GhRepo[]): void => {
      for (const r of list) {
        if (!seen.has(r.full_name)) {
          seen.add(r.full_name)
          merged.push(r)
        }
      }
      this.updateProgress({
        phase: `正在搜索 GitHub…已发现 ${merged.length} 个仓库${this.maxRepos > 0 ? `（测试上限 ${this.maxRepos}）` : ''}`,
        total: merged.length,
      })
    }

    if (this.maxRepos > 0) {
      // 限量模式：只收录前 N 个
      push((await this.searchQuery(`topic:${this.topic}`, this.maxRepos)).items)
      push((await this.searchQuery(`${this.topic} in:name,description`, this.maxRepos)).items)
      return merged.slice(0, this.maxRepos)
    }

    // 全量模式：搜完为止
    const topicFirst = await this.searchQuery(`topic:${this.topic}`, 1000)
    push(topicFirst.items)
    if (topicFirst.truncated) {
      for (const slice of GithubSync.STAR_SLICES) {
        push((await this.searchQuery(`topic:${this.topic} ${slice}`, 1000)).items)
      }
    }
    const kwFirst = await this.searchQuery(`${this.topic} in:name,description`, 1000)
    push(kwFirst.items)
    if (kwFirst.truncated) {
      for (const slice of GithubSync.STAR_SLICES) {
        push((await this.searchQuery(`${this.topic} in:name,description ${slice}`, 1000)).items)
      }
    }
    return merged
  }

  /** README 抓取 + 简介提取（第一条有效段落，截断 140 字）。 */
  async extractDescription(fullName: string, fallback: string | null): Promise<string> {
    const res = await fetch(
      `https://raw.githubusercontent.com/${fullName}/HEAD/README.md`,
      { headers: { 'User-Agent': 'dsh-store-server' } },
    ).catch(() => null)
    if (!res || !res.ok) return fallback ?? '（README 无有效段落）'
    const text = (await res.text()).slice(0, 32 * 1024)
    const cleaned = text
      .replace(/<!--.*?-->/gs, '')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[|>_*~`]/g, '')
    const lines = cleaned
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith('!') && !/^(npm|yarn|pnpm|git|curl|docker|License|MIT|Apache|Build|Coverage|Tests?|Downloads?)/i.test(l))
    const picked = lines[0] ?? fallback ?? '（README 无有效段落）'
    return picked.length > 140 ? picked.slice(0, 140) + '…' : picked
  }

  /** 质量评分（0~100，启发式）。 */
  qualityScore(repo: GhRepo, description: string): number {
    let score = 40
    if (description && description.length > 20) score += 20
    if (repo.description) score += 10
    if (repo.license?.spdx_id) score += 15
    if (repo.stargazers_count > 0) score += Math.min(15, Math.round(repo.stargazers_count / 200))
    return Math.min(100, score)
  }

  /** 单条提取管线：仓库 → 插件条目（提速收录复用）。 */
  async extractPlugin(fullName: string): Promise<Plugin | null> {
    const res = await this.gh(`/repos/${fullName}`)
    if (!res) return null
    const repo = (await res.json().catch(() => null)) as GhRepo | null
    if (!repo) return null
    const repoShort = fullName.split('/')[1]
    // 识别规则（dsh_install_types）：package.json 含 dsh 字段 → Plugin；
    // preset/<name>/agent.cordis.yml 存在 → Preset；两者都有 = 双形态，按 Plugin 收录并携带 preset_name。
    const pkg = await this.fetchPackageJson(fullName)
    const presets = await this.detectPresets(fullName)
    const pluginCandidate = !!pkg?.name && (!!pkg.dsh || presets.length === 0)
    const kind: Plugin['kind'] = pluginCandidate ? 'plugin' : 'preset'
    const presetName = presets[0]
    // 安装地址：Plugin = npm 包名或 git spec；Preset = 复制到 .agent-presets/<preset_name>。
    const npm = kind === 'plugin' ? await this.lookupNpm(pkg?.name ?? null) : null
    const id = pkg?.name ?? (kind === 'preset' && presetName ? presetName : repoShort)
    const install = kind === 'preset' ? `preset:${presetName ?? repoShort}` : npm ? id : `github:${fullName}`
    const version = npm?.latest ?? pkg?.version ?? '1.0.0'
    const description = await this.extractDescription(fullName, repo.description)
    const name = kind === 'preset' && presetName ? presetName : id
    return {
      id,
      kind,
      preset_name: presetName,
      version,
      name,
      description,
      repo: fullName,
      repo_url: repo.html_url,
      author: fullName.split('/')[0],
      source: 'community',
      stars: repo.stargazers_count,
      stars_delta_day: 0,
      stars_delta_7d: 0,
      trending_rank: null,
      likes: 0,
      downloads_7d: 0,
      quality_score: this.qualityScore(repo, description),
      tags: [],
      compat: kind === 'preset' ? 'DSH 预设（重启后新建空白会话选择）' : 'dsh ≥0.1.0-rc.5',
      install,
      is_new: true,
      security: { level: 0, score: 100, risk_tags: [], blocked: false },
      status: this.qualityScore(repo, description) < 60 ? 'needs_review' : 'listed',
      updated_at: repo.updated_at,
    }
  }

  /** 识别仓库内 preset/<name>/agent.cordis.yml（最多检查前 3 个目录）。 */
  private async detectPresets(fullName: string): Promise<string[]> {
    const res = await this.gh(`/repos/${fullName}/contents/preset`)
    if (!res) return []
    const data = (await res.json().catch(() => null)) as Array<{ type?: string; name?: string; path?: string }> | null
    if (!Array.isArray(data)) return []
    const names: string[] = []
    for (const item of data.slice(0, 3)) {
      if (item.type !== 'dir' || !item.name) continue
      const check = await this.gh(`/repos/${fullName}/contents/${item.path ?? 'preset/' + item.name}/agent.cordis.yml`)
      if (check) names.push(item.name)
    }
    return names
  }

  /** 仓库根 package.json（name/version/dsh 字段 = Plugin 识别依据）。 */
  private async fetchPackageJson(fullName: string): Promise<{ name?: string; version?: string; dsh?: { bundle?: string; profile?: string } } | null> {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${fullName}/HEAD/package.json`, {
        headers: { 'User-Agent': 'dsh-store-server' },
      })
      if (!res.ok) return null
      return (await res.json()) as { name?: string; version?: string; dsh?: { bundle?: string; profile?: string } }
    } catch {
      return null
    }
  }

  /** npm 注册表查询：已发布则取 latest 版本（安装地址校验）。 */
  private async lookupNpm(name: string | null): Promise<{ latest: string } | null> {
    if (!name) return null
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
        headers: { 'User-Agent': 'dsh-store-server' },
      })
      if (!res.ok) return null
      const data = (await res.json()) as { version?: string }
      return data?.version ? { latest: data.version } : null
    } catch {
      return null
    }
  }

  /** 全量同步：搜索 → 提取 → upsert → 星数快照 → 趋势榜重算。 */
  async runSync(target: SyncTarget): Promise<{ changed: number }> {
    if (!this.enabled) {
      this.status.last_result = '未配置 GITHUB_TOKENS'
      this.updateProgress({ running: false, stage: 'error', phase: '未配置 GitHub 搜索 token', finished_at: new Date().toISOString(), message: '未配置 GITHUB_TOKENS' })
      return { changed: 0 }
    }
    if (!this.progress.running) {
      this.progress = {
        running: true,
        stage: 'searching',
        phase: '正在搜索 GitHub 插件仓库…',
        total: 0,
        done: 0,
        current: null,
        changed: 0,
        started_at: new Date().toISOString(),
        finished_at: null,
        message: null,
      }
    } else {
      this.updateProgress({ stage: 'searching', phase: '正在搜索 GitHub 插件仓库…' })
    }
    const repos = await this.searchRepos()
    if (this.lastGhError) {
      const message = this.lastGhError.includes('401')
        ? 'GitHub 认证失败：token 无效或已撤销（请重新生成 classic PAT）'
        : `GitHub 访问失败：${this.lastGhError}`
      this.status = { ...this.status, last_run_at: new Date().toISOString(), last_result: message, last_searched: 0, last_error: this.lastGhError }
      this.updateProgress({ running: false, stage: 'error', phase: message, finished_at: new Date().toISOString(), message: this.lastGhError })
      target.log('sync', 'github.sync.error', { error: this.lastGhError })
      return { changed: 0 }
    }
    this.updateProgress({ stage: 'extracting', phase: `搜索完成，共 ${repos.length} 个仓库，开始提取插件信息…`, total: repos.length, done: 0 })
    const today = new Date().toISOString().slice(0, 10)
    const prevByRepo = new Map<string, number>()
    for (const s of target.starSnapshots) {
      if (s.date < today) prevByRepo.set(s.repo, Math.max(prevByRepo.get(s.repo) ?? 0, s.stars))
    }
    let changed = 0

    let processed = 0
    for (const repo of repos) {
      processed++
      this.updateProgress({
        stage: 'extracting',
        phase: `正在提取插件信息 ${processed}/${repos.length}`,
        done: processed,
        current: repo.full_name,
        changed,
      })
      const existing = target.plugins.find((p) => p.repo === repo.full_name)
      const plugin = existing ?? (await this.extractPlugin(repo.full_name))
      if (!plugin) continue
      if (!existing) {
        target.plugins.push(plugin)
        changed++
        this.updateProgress({ changed })
      } else {
        existing.stars = repo.stargazers_count
        existing.repo_url = repo.html_url
        existing.updated_at = repo.updated_at
      }
      // 星数快照（每日至少一个点）
      const hasToday = target.starSnapshots.some((s) => s.repo === repo.full_name && s.date === today)
      if (!hasToday) target.starSnapshots.push({ repo: repo.full_name, date: today, stars: repo.stargazers_count })
    }

    // 趋势榜重算：日增 = 今日 − 前一快照；新收录首日不参与排行
    this.updateProgress({ stage: 'trending', phase: '正在重算星数日增与趋势榜…', done: repos.length, current: null, changed })
    const todayStars = new Map(target.starSnapshots.filter((s) => s.date === today).map((s) => [s.repo, s.stars]))
    for (const p of target.plugins) {
      const todayS = todayStars.get(p.repo)
      const prevS = prevByRepo.get(p.repo)
      if (todayS !== undefined && prevS !== undefined) {
        p.stars_delta_day = todayS - prevS
        p.is_new = false
      } else if (!prevByRepo.has(p.repo)) {
        p.is_new = true
        p.stars_delta_day = 0
      }
    }
    // 近 7 天星增（用户端"近7天收藏增加"指标）：
    // 今日 −（date ≤ 7天前的最近快照）；收录不足 7 天用最早快照（= 收录以来全部增量）。
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const snapsByRepo = new Map<string, StarSnapshot[]>()
    for (const s of target.starSnapshots) {
      const arr = snapsByRepo.get(s.repo) ?? []
      arr.push(s)
      snapsByRepo.set(s.repo, arr)
    }
    for (const p of target.plugins) {
      const todayS = todayStars.get(p.repo)
      if (todayS === undefined) continue
      const arr = (snapsByRepo.get(p.repo) ?? []).sort((a, b) => a.date.localeCompare(b.date))
      if (arr.length === 0) {
        p.stars_delta_7d = 0
        continue
      }
      let base: StarSnapshot | undefined
      for (const s of arr) {
        if (s.date <= weekAgo) base = s
        else break
      }
      base ??= arr[0]
      p.stars_delta_7d = Math.max(0, todayS - base.stars)
    }
    const ranked = target.plugins
      .filter((p) => !p.is_new)
      .sort((a, b) => b.stars_delta_day - a.stars_delta_day)
      .slice(0, 20)
    target.plugins.forEach((p) => (p.trending_rank = null))
    ranked.forEach((p, i) => (p.trending_rank = i + 1))

    if (changed > 0) target.bumpPluginsRevision()
    const finishedAt = new Date().toISOString()
    this.status = { ...this.status, last_run_at: finishedAt, last_result: `成功 · 搜索 ${repos.length} 仓库 · ${changed} 变更`, last_changed: changed, last_searched: repos.length, last_error: null }
    this.updateProgress({
      running: false,
      stage: 'done',
      phase: `同步完成：搜索 ${repos.length} 个仓库，${changed} 个变更`,
      done: repos.length,
      total: repos.length,
      current: null,
      changed,
      finished_at: finishedAt,
      message: null,
    })
    target.log('sync', 'github.sync', { searched: repos.length, changed })
    return { changed }
  }

  /** GitHub API 请求（失败自动重试一次：网络抖动时第一次失败第二次成功是常态）。 */
  private async ghRetry(path: string): Promise<Response | null> {
    let res = await this.gh(path)
    if (res) return res
    await new Promise((r) => setTimeout(r, 800))
    res = await this.gh(path)
    return res
  }

  /** 检测本项目最新 Release（v3.7 V1：只提醒不自动更，升级动作由管理员触发）。 */
  async checkLatestRelease(repoUrl: string): Promise<ReleaseInfo | null> {
    const m = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/)
    if (!m) return null
    const res = await this.ghRetry(`/repos/${m[1]}/${m[2]}/releases/latest`)
    if (!res) return null
    const data = (await res.json().catch(() => null)) as { tag_name?: string; name?: string | null; published_at?: string; body?: string | null } | null
    if (!data) return null
    return { tag: data.tag_name ?? null, name: data.name ?? null, published_at: data.published_at ?? null, body: data.body ?? null }
  }

  /** 检测默认分支最新提交（跟踪通道 = commit 时使用）。 */
  async checkLatestCommit(repoUrl: string): Promise<{ sha: string; message: string | null; at: string | null } | null> {
    const m = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/)
    if (!m) return null
    const infoRes = await this.ghRetry(`/repos/${m[1]}/${m[2]}`)
    const info = infoRes ? ((await infoRes.json().catch(() => null)) as { default_branch?: string } | null) : null
    const branch = info?.default_branch ?? 'main'
    const res = await this.ghRetry(`/repos/${m[1]}/${m[2]}/commits/${branch}`)
    if (!res) return null
    const data = (await res.json().catch(() => null)) as { sha?: string; commit?: { message?: string; committer?: { date?: string | null } | null } | null } | null
    if (!data?.sha) return null
    return { sha: data.sha, message: data.commit?.message ?? null, at: data.commit?.committer?.date ?? null }
  }
}
