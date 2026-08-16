-- 012_combo_install_mode.sql —— 组合安装方式 / 组合状态扩展 / 私人公告
-- ① 组合成员安装方式：auto=一键直接装(默认,兼容旧数据)；manual=手动安装(打开插件页面自行安装)
ALTER TABLE combo_members ADD COLUMN IF NOT EXISTS install_mode TEXT NOT NULL DEFAULT 'auto';
-- ② 组合状态新增 unpublished(下架)：pending 待审 / published 已发布 / unpublished 已下架 / removed 已删除
ALTER TABLE combos DROP CONSTRAINT IF EXISTS combos_status_check;
ALTER TABLE combos ADD CONSTRAINT combos_status_check CHECK (status IN ('pending','published','unpublished','removed'));
-- ③ 私人公告：user_id 非空 = 仅该用户可见(管理端对组合发布/下架/删除时提醒作者)；NULL = 全站公告
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_announcements_user ON announcements (user_id);
