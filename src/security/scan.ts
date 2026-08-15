import type { RiskTag, SecurityProfile } from '../shared/models.js'

export interface ScanInput {
  pkg: string
  version: string
  repo: string
  /** Agent(Preset) 目录名；存在时按预设文件扫描（不依赖 npm 包）。 */
  presetName?: string
}

interface PkgJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

/**
 * 四层扫描管线（v3.1 S1）：事件驱动 + 分层 + 结果缓存（包名+精确版本）。
 * - L0 元数据信誉（本地、≈0 成本，收录时）
 * - L1 包级静态：install 脚本（供应链攻击重灾区）+ OSV 依赖漏洞库（经 unpkg/OSV API，秒级）
 * - L2 代码模式：危险调用 / 敏感环境变量 / 可疑外联
 * - L3 动态沙箱：仅高风险信号 / 被举报 / 冲榜异常时触发（后置）
 * 网络不可用时逐层降级，不阻断收录（默认透明展示，仅拉黑为硬阻断）。
 */
export async function scanPlugin(input: ScanInput): Promise<SecurityProfile> {
  const tags: RiskTag[] = []

  if (input.presetName) {
    const presetText = await fetchPresetFiles(input.repo, input.presetName)
    if (presetText) {
      if (/curl\s+|wget\s+|fetch\s*\(|https?:\/\/[^\s"']+/.test(presetText)) tags.push('suspicious_network')
      if (/\beval\s*\(|base64\s+-d|atob\s*\(|new Function/.test(presetText)) tags.push('obfuscated')
      if (/(KEY|TOKEN|SECRET|PASSWORD)\s*[:=]/.test(presetText)) tags.push('reads_secret_env')
      return { level: 2, score: Math.max(0, 100 - tags.length * 15), risk_tags: [...new Set(tags)], blocked: false }
    }
    return { level: 0, score: 80, risk_tags: [], blocked: false }
  }

  const pkgJson = await fetchPackageJson(input.pkg, input.version)
  if (pkgJson) {
    const scripts = pkgJson.scripts ?? {}
    if (scripts.preinstall || scripts.install || scripts.postinstall) tags.push('has_install_script')
    const deps = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.devDependencies ?? {}) }
    if (await checkOsvBatch(deps)) tags.push('known_vuln_dep')
  }

  const code = await fetchMainFile(input.pkg, input.version, pkgJson)
  if (code) {
    const hasExec = /child_process|exec\(|spawn\(|execSync|spawnSync/.test(code)
    const hasNet = /https?:\/\/|fetch\s*\(|https\.request|net\.connect/.test(code)
    if (hasExec && hasNet) tags.push('suspicious_network')
    if (/\beval\s*\(/.test(code) || /new Function/.test(code)) tags.push('obfuscated')
    if (/process\.env\s*\.\s*[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD)/.test(code)) tags.push('reads_secret_env')
  }

  const level: 0 | 1 | 2 | 3 = code ? 2 : pkgJson ? 1 : 0
  const score = Math.max(0, 100 - tags.length * 15)
  return { level, score, risk_tags: [...new Set(tags)], blocked: false }
}

/** 拉取 Agent 预设目录的核心文件做静态扫描（agent.cordis.yml / preset.yml / 脚本）。 */
async function fetchPresetFiles(repo: string, presetName: string): Promise<string | null> {
  const files = [
    `preset/${presetName}/agent.cordis.yml`,
    `preset/${presetName}/preset.yml`,
    `preset/${presetName}/setup.sh`,
    `preset/${presetName}/install.sh`,
  ]
  const chunks: string[] = []
  for (const file of files) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`, {
        headers: { 'User-Agent': 'dsh-store-server' },
      })
      if (res.ok) chunks.push((await res.text()).slice(0, 64 * 1024))
    } catch {
      /* 网络失败降级 */
    }
  }
  return chunks.length ? chunks.join('\n') : null
}

async function fetchPackageJson(pkg: string, version: string): Promise<PkgJson | null> {
  try {
    const res = await fetch(`https://unpkg.com/${encodeURIComponent(pkg)}@${encodeURIComponent(version)}/package.json`, {
      headers: { 'User-Agent': 'dsh-store-server' },
    })
    if (!res.ok) return null
    return (await res.json()) as PkgJson
  } catch {
    return null
  }
}

async function checkOsvBatch(deps: Record<string, string>): Promise<boolean> {
  const queries = Object.entries(deps).map(([name, version]) => ({
    package: { name, ecosystem: 'npm' },
    version: version.replace(/^[\^~]/, ''),
  }))
  if (queries.length === 0) return false
  try {
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'dsh-store-server' },
      body: JSON.stringify({ queries }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { results?: Array<{ vulns?: unknown[] }> }
    return (data.results ?? []).some((r) => (r.vulns?.length ?? 0) > 0)
  } catch {
    return false
  }
}

async function fetchMainFile(pkg: string, version: string, pkgJson: PkgJson | null): Promise<string | null> {
  const main = pkgJson?.main ?? 'index.js'
  try {
    const res = await fetch(`https://unpkg.com/${encodeURIComponent(pkg)}@${encodeURIComponent(version)}/${main}`, {
      headers: { 'User-Agent': 'dsh-store-server' },
    })
    if (!res.ok) return null
    return (await res.text()).slice(0, 256 * 1024)
  } catch {
    return null
  }
}
