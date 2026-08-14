-- 001_init.sql —— 核心表（插件 / 用户 / 组合 / 点赞 / 云端清单 / 公告 / 上报 / 匿名会话 / 审计）
-- 纪律：迁移只增不随意删；删除类变更延迟一个版本周期（expand-contract）。

-- 插件索引（服务端抓取 GitHub 后落地；双指标分离：stars 与 likes 永不合并）
CREATE TABLE IF NOT EXISTS plugins (
  id              TEXT PRIMARY KEY,                 -- 包名，如 "dsh-memory"
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  repo            TEXT NOT NULL UNIQUE,             -- owner/repo（联邦去重键）
  repo_url        TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL CHECK (source IN ('official','community')),
  stars           INTEGER NOT NULL DEFAULT 0,       -- GitHub 星数（只读镜像）
  stars_delta_day INTEGER NOT NULL DEFAULT 0,       -- 日增星数
  trending_rank   INTEGER,                          -- 趋势榜名次（不在榜为 NULL）
  likes           INTEGER NOT NULL DEFAULT 0,       -- 本站点赞
  downloads_7d    INTEGER NOT NULL DEFAULT 0,       -- 近 7 天滚动下载
  quality_score   INTEGER NOT NULL DEFAULT 0,
  tags            JSONB NOT NULL DEFAULT '[]',
  compat          TEXT NOT NULL DEFAULT '',
  security_level  INTEGER NOT NULL DEFAULT 0,       -- 已通过最高扫描层 0~3
  security_score  INTEGER NOT NULL DEFAULT 100,
  risk_tags       JSONB NOT NULL DEFAULT '[]',
  blocked         BOOLEAN NOT NULL DEFAULT FALSE,   -- 唯一硬阻断：拉黑
  status          TEXT NOT NULL DEFAULT 'listed'
                  CHECK (status IN ('listed','blocked','needs_review','pending')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plugins_trending ON plugins (trending_rank);
CREATE INDEX IF NOT EXISTS idx_plugins_status   ON plugins (status);

-- 用户（GitHub OAuth 唯一登录；不采集头像；home_server 为联邦身份归属）
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL UNIQUE,
  login         TEXT NOT NULL,
  name          TEXT,
  home_server   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','banned','deactivated')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 组合（Bundle）
CREATE TABLE IF NOT EXISTS combos (
  id            TEXT PRIMARY KEY,                    -- 联邦限定 id：{域名}:{本地ID}
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  author_id     TEXT,                                -- 注销后置 NULL（匿名保留）
  author_name   TEXT NOT NULL DEFAULT '已注销用户',
  likes         INTEGER NOT NULL DEFAULT 0,
  downloads_7d  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','published','removed')),
  origin_server TEXT NOT NULL,                       -- home 权威
  version       INTEGER NOT NULL DEFAULT 1,          -- 副本同步版本号
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_combos_status ON combos (status);

-- 组合成员（弱引用：包名 + 版本）
CREATE TABLE IF NOT EXISTS combo_members (
  combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  pkg      TEXT NOT NULL,
  version  TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY (combo_id, pkg)
);

-- 点赞（唯一索引防刷：user + target）
CREATE TABLE IF NOT EXISTS likes (
  user_id    TEXT NOT NULL,
  target     TEXT NOT NULL,                          -- 插件包名或组合联邦 id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target)
);

-- 云端安装清单（登录用户专属；卸载即删）
CREATE TABLE IF NOT EXISTS user_installs (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target          TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('plugin','combo')),
  version         TEXT NOT NULL,
  source_combo_id TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target, type)
);

-- 公告（发布 = 手动推送更新提醒；LB 集群内按源分标签）
CREATE TABLE IF NOT EXISTS announcements (
  id            TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('info','important')),
  content       TEXT NOT NULL,
  origin_server TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 库外插件上报（v3.1 S4；上报人数 = 收录优先级信号）
CREATE TABLE IF NOT EXISTS reports (
  id          BIGSERIAL PRIMARY KEY,
  pkg         TEXT NOT NULL,
  repo_url    TEXT,
  version     TEXT,
  reporter_id TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','included','invalid','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_pkg ON reports (pkg);

-- 匿名会话（v3.2 S8.3：短期匿名 token，绑定安装实例 id）
CREATE TABLE IF NOT EXISTS anonymous_sessions (
  token        TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 审计日志（必要资料，永久保留）
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
