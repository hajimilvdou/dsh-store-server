-- 010_stars_delta_7d.sql —— 插件表补列：近 7 天 GitHub 星数增量（用户端"近7天收藏增加"指标，替换"近7天下载"展示）
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS stars_delta_7d INTEGER NOT NULL DEFAULT 0;
