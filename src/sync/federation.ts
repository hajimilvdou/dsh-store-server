import type { Repo } from '../repo/types.js'
import type { FedRelation } from '../repo/data.js'
import type { Combo } from '../shared/models.js'
import type { ServerConfig } from '../shared/config.js'

/**
 * 联邦数据同步（v3.8）：周期性拉取对端快照,按关系选择同步类别。
 * - plugins / agents / users：镜像存入 federation_data(管理端可查看统计)
 * - combos：合并进组合主表(组合 id 天然含来源域名,无冲突;删除同步由全量替换保证)
 * 默认 24h 一轮(配置 federation.sync_interval_h)；可单方面断开,断开时通知对方。
 */

export type FedSyncKind = 'plugins' | 'agents' | 'combos' | 'users'

export const FED_KINDS: FedSyncKind[] = ['plugins', 'agents', 'combos', 'users']

export const FED_KIND_LABEL: Record<FedSyncKind, string> = {
  plugins: '插件',
  agents: 'Agent',
  combos: '插件组',
  users: '用户及云端',
}

/** 关系 share.kinds 解析：缺省(旧关系/未选择) = 全部类别。 */
export function shareKinds(rel: FedRelation): FedSyncKind[] {
  const raw = String(rel.share?.kinds ?? '')
  const kinds = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const valid = kinds.filter((k) => (FED_KINDS as string[]).includes(k)) as FedSyncKind[]
  return valid.length ? valid : [...FED_KINDS]
}

export class FedSync {
  constructor(
    private readonly repo: Repo,
    private readonly getConfig: () => ServerConfig,
  ) {}

  /** 拉取对端一类数据(带本服联邦密码)。 */
  private async fetchPeer(rel: FedRelation, kind: FedSyncKind): Promise<unknown[]> {
    const cfg = this.getConfig().federation
    if (!cfg.enabled || !cfg.secret) throw new Error('本服未开启联邦或未配置联邦密码')
    const url = rel.peer_url.replace(/\/+$/, '') + '/api/v1/federation/sync?kind=' + encodeURIComponent(kind)
    const res = await fetch(url, {
      headers: { 'X-Federation-Secret': cfg.secret, 'User-Agent': 'dsh-store-server' },
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`对端返回 HTTP ${res.status}`)
    const body = (await res.json()) as { items?: unknown[] }
    return body.items ?? []
  }

  /** 同步一个关系的全部已选类别；失败记录到 share.error 并在管理端可见。 */
  async syncRelation(rel: FedRelation): Promise<{ ok: boolean; counts: Record<string, number>; error: string | null }> {
    const kinds = shareKinds(rel)
    const counts: Record<string, number> = {}
    let error: string | null = null
    for (const kind of kinds) {
      try {
        const items = await this.fetchPeer(rel, kind)
        if (kind === 'combos') {
          this.repo.mergeFedCombos(rel.peer_url, items as Combo[])
        } else {
          this.repo.setFedData(rel.peer_url, kind, items)
        }
        counts[kind] = items.length
      } catch (e) {
        error = `${FED_KIND_LABEL[kind]}同步失败：${e instanceof Error ? e.message : String(e)}`
        counts[kind] = -1
        break
      }
    }
    const patch: Record<string, string> = {
      kinds: kinds.join(','),
      last_sync_at: new Date().toISOString(),
      counts: JSON.stringify(counts),
    }
    if (error) patch.error = error
    else if (rel.share?.error) patch.error = ''
    this.repo.updateFedShare(rel.id, patch)
    return { ok: !error, counts, error }
  }

  /** 同步全部已连接关系(调度器/手动触发共用)。 */
  async runOnce(): Promise<Array<{ peer: string; ok: boolean; error: string | null; counts: Record<string, number> }>> {
    const out: Array<{ peer: string; ok: boolean; error: string | null; counts: Record<string, number> }> = []
    for (const rel of this.repo.getFedRelations().filter((r) => r.status === 'connected')) {
      const r = await this.syncRelation(rel)
      out.push({ peer: rel.peer_url, ok: r.ok, error: r.error, counts: r.counts })
    }
    return out
  }

  /** 通知对端(解除连接/系统消息)。失败静默(对方可能已下线)。 */
  async notifyPeer(rel: FedRelation, body: string): Promise<void> {
    const cfg = this.getConfig().federation
    if (!cfg.enabled || !cfg.secret) return
    try {
      await fetch(rel.peer_url.replace(/\/+$/, '') + '/api/v1/federation/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Federation-Secret': cfg.secret, 'User-Agent': 'dsh-store-server' },
        body: JSON.stringify({ relation_id: 'system', body }),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      /* 对方不可达时仅本服记录 */
    }
  }
}
