-- 003_federation.sql —— 联邦互联（服务器间关系 / 事件审计 / 站内信）
-- 联邦密码 ≠ 访问密码（严格分离）；双向凭证 + 签名；全 TLS；事件留审计。

CREATE TABLE IF NOT EXISTS federation_relations (
  id          TEXT PRIMARY KEY,
  peer_url    TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','connected','rejected','disconnected')),
  share       JSONB NOT NULL DEFAULT '{}',           -- 逐项勾选：插件补充/组合/计数/趋势/安全情报
  mode        TEXT NOT NULL DEFAULT 'snapshot'
              CHECK (mode IN ('snapshot','realtime')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 联邦事件（谁发起、谁接受、共享了什么、何时断开）
CREATE TABLE IF NOT EXISTS federation_events (
  id          BIGSERIAL PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES federation_relations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 服务器间站内信（限长 1000 字 · 双方留档审计）
CREATE TABLE IF NOT EXISTS federation_messages (
  id          BIGSERIAL PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES federation_relations(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fed_msgs_relation ON federation_messages (relation_id, created_at);
