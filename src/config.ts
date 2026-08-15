import { DEFAULT_CONFIG, type ServerConfig } from './shared/config.js'

/**
 * 加载服务端配置：以 shared 中的生产默认为基底，叠加环境变量覆盖。
 * 密钥类（访问密码/联邦密码/token 池等）只来自环境变量或配置表，不写死在代码里。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cfg = structuredClone(DEFAULT_CONFIG)

  const num = (v: string | undefined, fallback: number): number =>
    v === undefined || v.trim() === '' ? fallback : Number(v)
  const bool = (v: string | undefined, fallback: boolean): boolean =>
    v === undefined || v.trim() === '' ? fallback : v === '1' || v.toLowerCase() === 'true'

  cfg.sync.github_fetch_interval_h = num(env.SYNC_FETCH_INTERVAL_H, cfg.sync.github_fetch_interval_h)
  cfg.sync.max_repos = num(env.SYNC_MAX_REPOS, cfg.sync.max_repos)
  cfg.sync.data_heartbeat_min = num(env.SYNC_HEARTBEAT_MIN, cfg.sync.data_heartbeat_min)
  cfg.trending.size = num(env.TRENDING_SIZE, cfg.trending.size)
  cfg.server.access_password = env.ACCESS_PASSWORD ?? cfg.server.access_password
  cfg.federation.enabled = bool(env.FEDERATION_ENABLED, cfg.federation.enabled)
  cfg.federation.secret = env.FEDERATION_SECRET ?? cfg.federation.secret
  cfg.update.repo_url = env.UPDATE_REPO_URL ?? cfg.update.repo_url
  cfg.update.track = env.UPDATE_TRACK === 'commit' ? 'commit' : cfg.update.track
  cfg.retention.raw_data_days = num(env.RETENTION_RAW_DATA_DAYS, cfg.retention.raw_data_days)

  return cfg
}
