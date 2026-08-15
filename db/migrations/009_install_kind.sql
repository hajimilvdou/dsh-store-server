-- Plugin / Agent(Preset) 类型区分：kind + preset_name
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'plugin';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS preset_name TEXT;
CREATE INDEX IF NOT EXISTS idx_plugins_kind ON plugins(kind);
