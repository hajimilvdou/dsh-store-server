/** 仓库存储的领域对象（MemoryRepo 与 PgRepo 共用）。 */

export interface StoredLike {
  user_id: string
  target: string
  at: string
}

export interface StoredReport {
  id: number
  pkg: string
  repo_url: string | null
  version: string
  reporter_id: string | null
  status: 'pending' | 'included' | 'invalid' | 'rejected'
  created_at: string
}

/** 风控队列条目（v3.2 S8：疑似刷赞先隔离为"待确认"，复核后生效或清除）。 */
export interface StoredRiskLike {
  id: number
  user_id: string
  login: string
  target: string
  ip: string
  reason: string
  status: 'pending' | 'included' | 'rejected'
  at: string
}

export interface CloudInstall {
  user_id: string
  target: string
  type: 'plugin' | 'combo'
  version: string
  source_combo_id: string | null
  at: string
}

export interface FedRelation {
  id: string
  peer_url: string
  status: 'pending' | 'connected' | 'rejected' | 'disconnected'
  share: Record<string, string>
  mode: 'snapshot' | 'realtime'
  rtt_ms: number | null
  created_at: string
}

export interface FedMessage {
  id: number
  relation_id: string
  direction: 'in' | 'out'
  body: string
  created_at: string
}

export interface UpdateState {
  stage: 'idle' | 'fetching' | 'building' | 'migrating' | 'switching' | 'selfcheck' | 'done' | 'failed'
  from_version: string
  to_version: string
  log: string[]
  error: string | null
  started_by: string
  started_at: string
  finished_at: string | null
}

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  created_at: string
}
