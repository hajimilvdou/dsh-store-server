-- 004_retention.sql —— 非必要资料（默认保留 2 天自动清理，可配置）
-- 必要资料（插件/组/用户/点赞/公告/审计/安全情报）永久保留；
-- 以下均为非必要，到期自动删，每次清理写审计。

CREATE TABLE IF NOT EXISTS raw_caches (
  key        TEXT PRIMARY KEY,                       -- 如 readme:{owner}/{repo}
  kind       TEXT NOT NULL,                          -- readme | github_response
  payload    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_raw_caches_created ON raw_caches (created_at);

CREATE TABLE IF NOT EXISTS request_logs (
  id         BIGSERIAL PRIMARY KEY,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs (created_at);

-- 下载明细（聚合成 downloads_7d 后明细即删）
CREATE TABLE IF NOT EXISTS download_details (
  id         BIGSERIAL PRIMARY KEY,
  target     TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_download_details_created ON download_details (created_at);

-- 清理函数：删除超过保留期的非必要数据，返回释放的行数（写审计由调用方完成）
CREATE OR REPLACE FUNCTION cleanup_retention(days INTEGER)
RETURNS INTEGER AS $$
DECLARE
  total INTEGER := 0;
BEGIN
  DELETE FROM raw_caches        WHERE created_at < now() - make_interval(days => days); total := total + 1;
  DELETE FROM request_logs      WHERE created_at < now() - make_interval(days => days);
  DELETE FROM download_details  WHERE created_at < now() - make_interval(days => days);
  DELETE FROM anonymous_sessions WHERE expires_at < now();
  RETURN total;
END;
$$ LANGUAGE plpgsql;
