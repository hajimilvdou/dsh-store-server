-- 013_federation_sync.sql —— 联邦数据同步镜像
-- 联邦互联数据同步：插件/Agent/插件组/用户及云端清单,按关系选择类别,周期性拉取对端快照。
-- 组合合并进 combos 主表(组合 id 天然含来源域名,无冲突)；插件/Agent/用户镜像存本表供管理端查看。
CREATE TABLE IF NOT EXISTS federation_data (
  peer_url   TEXT NOT NULL,          -- 对端服务器地址(唯一标识一个关系)
  kind       TEXT NOT NULL,          -- plugins | agents | combos | users
  payload    JSONB NOT NULL,         -- 对端快照数据(数组)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (peer_url, kind)
);
