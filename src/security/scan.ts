import type { RiskTag, SecurityProfile } from '../shared/models.js'

export interface ScanInput {
  pkg: string
  version: string
  repo: string
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
