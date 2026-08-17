-- 云端安装清单支持 Agent 类型（客户端"上传本地到云端"会上传已装 Agent）。
ALTER TABLE user_installs DROP CONSTRAINT IF EXISTS user_installs_type_check;
ALTER TABLE user_installs ADD CONSTRAINT user_installs_type_check CHECK (type IN ('plugin','combo','agent'));