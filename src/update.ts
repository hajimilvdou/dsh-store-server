import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { UpdateState } from './repo/data.js'
import type { Repo } from './repo/types.js'

/** 运行时读取 package.json 版本（无前缀，如 0.1.0）；容器内 npm_package_version 不存在，避免硬编码回退。 */
export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.1.0'
  } catch {
    return process.env.npm_package_version ?? '0.1.0'
  }
}

/** 带 v 前缀的版本号（更新/检测显示用）。 */
export function serverVersionTag(): string {
  return `v${serverVersion()}`
}

/** 归一化版本 tag：补 v 前缀、补齐三位（v0.1 → v0.1.0，0.1 → v0.1.0），用于显示与比较。 */
export function normVersionTag(tag: string): string {
  const t = String(tag ?? '').trim()
  if (!t) return ''
  const withV = t.startsWith('v') ? t : `v${t}`
  const parts = withV.slice(1).split('.')
  while (parts.length < 3) parts.push('0')
  return `v${parts.slice(0, 3).join('.')}`
}

/**
 * 当前实际部署版本（容器部署 = 面板热更新写入的镜像 tag 文件，回退 package.json 版本）。
 * 容器内 /opt/dsh-store 由部署脚本挂载，api.current-image 记录最后一次成功热更新的镜像。
 */
export function deployedVersionTag(): string {
  try {
    const cur = readFileSync('/opt/dsh-store/api.current-image', 'utf8').trim()
    const m = cur.match(/:([^:/]+)$/)
    if (m?.[1]) return m[1]
  } catch {
    /* 非容器部署或文件不存在 */
  }
  return serverVersionTag()
}

/**
 * 在线一键更新（v3.7 V1/V2）：
 * 执行预置脚本 scripts/update.sh <version>（git 拉取 → docker 构建 → 迁移 → 切换 → 自检 → 失败回滚），
 * 全流程状态写回 repo.updateState，管理端「系统更新」页实时展示。
 * 安全约束：只执行预置脚本 + 白名单版本号，不存在任意命令执行面。
 */
export class UpdateService {
  private running = false

  constructor(private readonly repo: Repo) {}

  get busy(): boolean {
    return this.running
  }

  async run(version: string): Promise<UpdateState> {
    if (this.running) {
      const cur = this.repo.getUpdateState()
      return { ...cur, error: '已有更新任务在运行' }
    }
    this.running = true
    try {
      const current = deployedVersionTag()
      const script = path.resolve(process.cwd(), 'scripts', 'update.sh')

      const setState = (patch: Partial<UpdateState>): void => {
        this.repo.setUpdateState({ ...this.repo.getUpdateState(), ...patch })
      }
      setState({
        stage: 'fetching',
        from_version: current,
        to_version: version,
        log: ['fetching: 启动更新脚本 scripts/update.sh ' + version],
        error: null,
        started_by: 'admin',
        started_at: new Date().toISOString(),
        finished_at: null,
      })

      const outcome = await new Promise<{ ok: boolean; lines: string[] }>((resolve) => {
        const lines: string[] = []
        try {
          const child = spawn('bash', [script, version], {
            cwd: path.resolve(process.cwd()),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
          child.stdout?.on('data', (d: Buffer) => lines.push(String(d).trim()))
          child.stderr?.on('data', (d: Buffer) => lines.push(String(d).trim()))
          child.on('error', (e) => resolve({ ok: false, lines: [`update: 无法启动更新脚本（${e instanceof Error ? e.message : String(e)}）；请确认 bash/git 可用，或在部署机上直接执行 ./scripts/deploy.sh`] }))
          child.on('close', (code) => resolve({ ok: code === 0, lines }))
        } catch (e) {
          resolve({ ok: false, lines: [`update: 无法启动更新脚本（${e instanceof Error ? e.message : String(e)}）；请确认 bash/git 可用，或在部署机上直接执行 ./scripts/deploy.sh`] })
        }
      })

      if (outcome.ok) {
        setState({
          stage: 'done',
          log: [...this.repo.getUpdateState().log, ...outcome.lines.slice(-20)],
          error: null,
          finished_at: new Date().toISOString(),
        })
      } else {
        setState({
          stage: 'failed',
          log: [...this.repo.getUpdateState().log, ...outcome.lines.slice(-20)],
          error: outcome.lines.join('\n').slice(0, 800),
          finished_at: new Date().toISOString(),
        })
      }
      return this.repo.getUpdateState()
    } finally {
      this.running = false
    }
  }
}
