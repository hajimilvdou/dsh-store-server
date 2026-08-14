-- 006_plugin_fields.sql —— 插件表补列（契约演进：最新版本号 / 新收录标记）
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT FALSE;
