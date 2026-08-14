-- 005_kv.sql —— 键值存储（配置 / 更新状态 / 拉黑列表 / 修订号等小型状态）
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
