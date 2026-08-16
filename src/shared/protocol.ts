/**
 * 协议与 manifest 契约。
 *
 * 协议纪律（v3.6 U2）：
 * 1. 握手时交换 protocol_version，全程按 min(双方) 通信；
 * 2. 未知字段忽略、绝不报错；
 * 3. 高版本特性对低版本节点自动降级/隐藏。
 */

/** 当前协议版本。跨不兼容窗口（默认 2 个 minor）拒绝互联。 */
export const PROTOCOL_VERSION = '1.0.0'

/** 软件名（联邦握手/心跳时随 software_version 一起上报）。 */
export const SOFTWARE_NAME = 'dsh-store'

/** 协议兼容窗口（minor 版本数），超出则拒绝互联并告警。 */
export const PROTOCOL_WINDOW = 2

/** 联邦/集群握手时交换的版本信息。 */
export interface SoftwareVersion {
  software_version: string
  protocol_version: string
}

/** 功能开关（随 manifest 下发，客户端据此渲染）。 */
export interface FeatureFlags {
  trending: boolean
  likes: boolean
  combos: boolean
  announcements: boolean
  federation: boolean
}

/** 联邦 / LB 集群节点信息。 */
export interface NodeInfo {
  id: string
  name: string
  url: string
  rtt_ms: number | null
  healthy: boolean
  /** 是否负载均衡成员（集群内免密/登录互认）。 */
  is_lb: boolean
}

/** 下发给客户端的配置补丁（服务端可配参数的客户端可见子集）。 */
export interface ClientConfigPatch {
  trending_size: number
  search_threshold: number
  onboarding_auto_open_times: number
  server_local_port: number
  ui_default_theme: 'system' | 'light' | 'dark'
  ui_window_min: [number, number]
  ui_window_max: [number, number]
  data_heartbeat_min: number
  combos_refresh_min: number
  restore_max_points: number
  combo_limit: number
  /** 插件组审核开关：true=发布需审核；false=发布直接上线。客户端弹窗提示用。 */
  combo_review_enabled?: boolean
}

/**
 * Manifest 心跳响应。客户端每次心跳拿它做版本比对，变了才拉增量。
 */
export interface Manifest {
  protocol_version: string
  software_version: string
  /** 所属 LB 集群 id；null = 独立源。用于判定换源场景（v3.4 M1）。 */
  cluster_id: string | null
  server_time: string
  /** 插件数据修订号（增量拉取游标）。 */
  plugins_revision: string
  /** 组数据修订号（增量拉取游标）。 */
  combos_revision: string
  /** 最新公告 id；与本地已读 id 比对决定是否点亮叹号角标。 */
  latest_announcement_id: string | null
  features: FeatureFlags
  nodes: NodeInfo[]
  client_config: ClientConfigPatch
  /** 客户端插件版本推送：服务端配置 client.plugin_version 非空时下发；
   *  客户端与自身版本比对，有更新 → 横幅提示 → 「我的 → 版本更新」一键在线更新。 */
  client_plugin: { version: string; install: string } | null
}

/** 插件数据通道的增量拉取参数。 */
export interface SinceQuery {
  since?: string
}

/** 通用增量响应包装（插件 / 组 / 公告共用）。 */
export interface Delta<T> {
  revision: string
  items: T[]
  /** 全量兜底时置 true。 */
  full: boolean
  /** 墓碑（删除传播，防止旧副本复活）。 */
  tombstones: string[]
}
