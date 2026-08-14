-- 007 匿名安装计数明细 + 风控队列（v3.2 S8 防护体系）
-- install_events：每次计数写一条；按天聚合产出 downloads_7d 后明细可删（v3.5 保留 2 天）。
-- risk_likes：疑似刷赞先隔离为待确认，人工复核后生效（included）或清除（rejected），不计入排行。

CREATE TABLE IF NOT EXISTS install_events (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL,
  target TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_events_target ON install_events (target, at);

CREATE TABLE IF NOT EXISTS risk_likes (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  target TEXT NOT NULL,
  ip TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_likes_status ON risk_likes (status);
