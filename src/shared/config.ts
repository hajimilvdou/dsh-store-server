/**
 * 可配置参数清单（v3 §9 起历次增补汇总）与默认值。
 *
 * 所有键以点号分层；服务端读环境变量 + 配置表，客户端拿到的是下发的
 * `ClientConfigPatch` 子集（见 protocol.ts），不直接读这里。
 */

export const CONFIG_KEYS = {
  /* 同步与抓取 */
  github_fetch_interval_h: 'sync.github_fetch_interval_h',
  data_heartbeat_min: 'sync.data_heartbeat_min',
  combos_refresh_min: 'sync.combos_refresh_min',
  snapshot_retention_days: 'trending.snapshot_retention_days',
  readme_fetch_kb: 'sync.readme_fetch_kb',
  max_repos: 'sync.max_repos',
  github_tokens: 'sync.github_tokens',

  /* 趋势榜 */
  trending_size: 'trending.size',
  trending_enabled: 'feature.trending',

  /* 引导 / UI */
  onboarding_auto_open_times: 'onboarding.auto_open_times',
  server_local_port: 'server.local_port',
  ui_default_theme: 'ui.default_theme',
  ui_window_min: 'ui.window_min',
  ui_window_max: 'ui.window_max',

  /* 服务器与联邦 */
  server_access_password: 'server.access_password',
  federation_enabled: 'federation.enabled',
  federation_secret: 'federation.secret',
  federation_share: 'federation.share',
  federation_mode: 'federation.mode',
  lb_node_rtt_interval: 'lb.node_rtt_interval',
  lb_auto_join_prompt: 'lb.auto_join_prompt',
  protocol_window: 'federation.protocol_window',

  /* 更新 */
  update_repo_url: 'update.repo_url',
  update_check_interval_min: 'update.check_interval_min',
  update_track: 'update.track',
  update_rollback_keep_images: 'update.rollback_keep_images',

  /* 安全 */
  security_scan_level: 'security.scan_level',
  security_blocklist: 'security.blocklist',
  report_rate_limit: 'report.rate_limit',
  anon_token_ttl: 'anon.token_ttl',

  /* 风控（v3.2 S8：疑似刷赞隔离阈值） */
  like_risk_same_ip_accounts: 'risk.like_same_ip_accounts',
  like_risk_same_ip_window_min: 'risk.like_same_ip_window_min',
  like_risk_new_account_min: 'risk.like_new_account_min',
  like_risk_toggle_window_min: 'risk.like_toggle_window_min',
  like_risk_toggle_count: 'risk.like_toggle_count',

  /* 账号 / 台账 */
  restore_max_points: 'restore.max_points',
  combo_limit: 'user.combo_limit',
  /** 插件组审核开关：开=用户发布进待审；关=发布直接实时上线。 */
  combo_review_enabled: 'user.combo_review_enabled',
  notify_badge_enabled: 'notify.badge_enabled',
  registration_enabled: 'user.registration_enabled',
  registration_methods: 'user.registration_methods',

  /* 排序 / 榜单 */
  sort_default: 'sort.default',
  like_age_weight: 'rank.like_age_weight',

  /* 告警 */
  alert_thresholds: 'alert.thresholds',
  alert_webhook: 'alert.webhook',

  /* 认证（配置中心可改，环境变量兜底） */
  github_client_id: 'auth.github_client_id',
  github_client_secret: 'auth.github_client_secret',
  jwt_secret: 'auth.jwt_secret',
  oauth_callback_url: 'auth.oauth_callback_url',

  /* 管理员 */
  admin_password: 'admin.password',

  /* 客户端插件版本推送 */
  client_plugin_version: 'client.plugin_version',
  client_install_spec: 'client.install_spec',

  /* 同步 / 数据保留 */
  sync_auto_on_new_source: 'sync.auto_on_new_source',
  retention_raw_data_days: 'retention.raw_data_days',

  /* 站内信 */
  message_max_length: 'message.max_length',
  message_rate_limit: 'message.rate_limit',
} as const

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS]

/** 全量配置对象（服务端持有）。 */
export interface ServerConfig {
  sync: {
    github_fetch_interval_h: number
    data_heartbeat_min: number
    combos_refresh_min: number
    readme_fetch_kb: number
    /** GitHub 搜索收录上限：0 = 服务器默认全量；>0 = 测试限量（如 100）。 */
    max_repos: number
    auto_on_new_source: boolean
    /** GitHub 搜索 token 池（classic PAT，多枚轮换）。配置中心可填；留空回落环境变量 GITHUB_TOKENS。 */
    github_tokens: string[]
  }
  trending: {
    size: number
    snapshot_retention_days: number
  }
  onboarding: {
    auto_open_times: number
  }
  server: {
    local_port: number
    access_password: string
    /** 本服对外地址(组合联邦 id 前缀与 origin_server 来源,如 https://blog.1qwq1.top)。 */
    public_url: string
  }
  ui: {
    default_theme: 'system' | 'light' | 'dark'
    window_min: [number, number]
    window_max: [number, number]
  }
  feature: {
    trending: boolean
    likes: boolean
    combos: boolean
    announcements: boolean
  }
  federation: {
    enabled: boolean
    secret: string
    /** 联邦数据同步间隔（小时，默认 24）：周期性拉取对端快照。 */
    sync_interval_h: number
    share: {
      plugin_supplements: boolean
      combos: boolean
      counts: boolean
      trending: boolean
      security_intel: boolean
    }
    mode: 'snapshot' | 'realtime'
    protocol_window: number
  }
  lb: {
    node_rtt_interval: number
    auto_join_prompt: boolean
  }
  update: {
    repo_url: string
    check_interval_min: number
    track: 'release' | 'commit'
    rollback_keep_images: number
  }
  security: {
    scan_level: 0 | 1 | 2 | 3
    blocklist: string[]
  }
  restore: {
    max_points: number
  }
  user: {
    combo_limit: number
    /** 插件组审核开关：true=用户发布需管理员审核(进 pending)；false=发布直接实时上线(published)。
     *  已通过审核的组合,作者后续编辑保存免审(保持 published)。 */
    combo_review_enabled: boolean
    /** 注册开关（关闭后新用户无法登录注册）。 */
    registration_enabled: boolean
    /** 可用注册方式（当前仅支持 'github'）。 */
    registration_methods: string[]
  }
  auth: {
    /** GitHub OAuth 应用 Client ID（配置中心可改，留空回落环境变量）。 */
    github_client_id: string
    github_client_secret: string
    /** JWT 签名密钥（更换后全员会话失效，需重新登录）。 */
    jwt_secret: string
    /**
     * OAuth 回调地址（本服务器对外完整地址，如 https://example.com）。
     * 作为 GitHub OAuth App 的 redirect_uri 前缀。自建/多服务器场景必须按各自域名填写；
     * 留空回落环境变量 OAUTH_CALLBACK_URL，两者皆空时登录接口 503 并提示配置。
     * （不再内置任何默认域名——每个部署的回调地址都由管理员自己声明。）
     */
    oauth_callback_url: string
  }
  admin: {
    /** 管理端访问密码（配置中心可改；留空回落环境变量 ADMIN_TOKEN；两者皆空时管理端 503。仅纯离线演示模式有默认值 mock-admin）。 */
    password: string
  }
  client: {
    /** 客户端插件最新版本号：兼容字段（旧版手动推送）；新逻辑由服务端自动检测仓库 package.json，见 routes.ts detectClientVersion。 */
    plugin_version: string
    /** 客户端插件安装 spec（内置默认 = 用户端仓库；可覆盖为 npm 包名或自建仓库）。 */
    install_spec: string
    /** 客户端插件版本推送开关：true=启用自动推送（manifest 下发自动检测到的最新版本）。 */
    push_enabled: boolean
  }
  notify: {
    badge_enabled: boolean
  }
  report: {
    rate_limit: number
  }
  anon: {
    token_ttl: number
  }
  risk: {
    /** 同一目标、同一 IP、N 个不同账号在窗口内集中点赞 → 疑似刷赞。 */
    like_same_ip_accounts: number
    like_same_ip_window_min: number
    /** 注册后 N 分钟内即点赞 → 疑似注册即赞。 */
    like_new_account_min: number
    /** 同一账号对同一目标 N 分钟内切换点赞达到 M 次 → 疑似高频刷量。 */
    like_toggle_window_min: number
    like_toggle_count: number
  }
  sort: {
    default: 'default' | 'stars' | 'likes' | 'downloads'
  }
  rank: {
    like_age_weight: number
  }
  alert: {
    thresholds: Record<string, number>
    webhook: string
  }
  message: {
    max_length: number
    rate_limit: number
  }
  retention: {
    raw_data_days: number
  }
}

/** 生产默认配置。 */
export const DEFAULT_CONFIG: ServerConfig = {
  sync: {
    github_fetch_interval_h: 24,
    data_heartbeat_min: 30,
    combos_refresh_min: 30,
    readme_fetch_kb: 32,
    max_repos: 0,
    auto_on_new_source: false,
    github_tokens: [],
  },
  trending: {
    size: 20,
    snapshot_retention_days: 90,
  },
  onboarding: {
    auto_open_times: 3,
  },
  server: {
    local_port: 0,
    access_password: '',
    public_url: 'https://blog.1qwq1.top',
  },
  ui: {
    default_theme: 'system',
    window_min: [360, 480],
    window_max: [720, 900],
  },
  feature: {
    trending: true,
    likes: true,
    combos: true,
    announcements: true,
  },
  federation: {
    enabled: true,
    secret: '',
    sync_interval_h: 24,
    share: {
      plugin_supplements: true,
      combos: true,
      counts: true,
      trending: true,
      security_intel: true,
    },
    mode: 'snapshot',
    protocol_window: 2,
  },
  lb: {
    node_rtt_interval: 60,
    auto_join_prompt: true,
  },
  update: {
    repo_url: '',
    check_interval_min: 60,
    track: 'release',
    rollback_keep_images: 2,
  },
  security: {
    scan_level: 2,
    blocklist: [],
  },
  restore: {
    max_points: 10,
  },
  user: {
    combo_limit: 3,
    combo_review_enabled: true,
    registration_enabled: true,
    registration_methods: ['github'],
  },
  auth: {
    github_client_id: '',
    github_client_secret: '',
    jwt_secret: '',
    oauth_callback_url: '',
  },
  admin: {
    password: '',
  },
  client: {
    plugin_version: '',
    install_spec: 'github:hajimilvdou/dsh-storecloud',
    push_enabled: true,
  },
  notify: {
    badge_enabled: true,
  },
  report: {
    rate_limit: 10,
  },
  anon: {
    token_ttl: 3600,
  },
  risk: {
    like_same_ip_accounts: 3,
    like_same_ip_window_min: 30,
    like_new_account_min: 10,
    like_toggle_window_min: 5,
    like_toggle_count: 3,
  },
  sort: {
    default: 'default',
  },
  rank: {
    like_age_weight: 1,
  },
  alert: {
    thresholds: {},
    webhook: '',
  },
  message: {
    max_length: 1000,
    rate_limit: 10,
  },
  retention: {
    raw_data_days: 2,
  },
}
