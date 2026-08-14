-- 002_star_snapshots.sql —— 星数历史快照（趋势榜数据源）
-- 每日至少一个快照点；日增星数 = 当日 − 前一快照；新收录首日不参与排行。

CREATE TABLE IF NOT EXISTS star_snapshots (
  repo  TEXT NOT NULL,
  date  DATE NOT NULL,
  stars INTEGER NOT NULL,
  PRIMARY KEY (repo, date)
);
CREATE INDEX IF NOT EXISTS idx_star_snapshots_date ON star_snapshots (date);
