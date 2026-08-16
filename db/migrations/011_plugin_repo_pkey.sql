-- 011_plugin_repo_pkey.sql —— 插件唯一键从 id 改为 repo(owner/repo)：
-- 不同作者的同名插件(同 id 不同 repo)可以同时收录与落库；
-- repo 天然全局唯一(联邦去重键)，id 允许重复(同名包/同名预设)。
ALTER TABLE plugins DROP CONSTRAINT plugins_pkey;
ALTER TABLE plugins ADD PRIMARY KEY (repo);
