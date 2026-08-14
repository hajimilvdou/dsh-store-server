-- 008_plugin_author_install.sql —— 插件表补列（作者 / 安装 spec，v3.4 提取管线产出）
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS author TEXT NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS install TEXT NOT NULL DEFAULT '';
