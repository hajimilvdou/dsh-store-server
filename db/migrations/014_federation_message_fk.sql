-- 014_federation_message_fk.sql —— 联邦站内信解除外键强制
-- 断连/解除通知使用 relation_id='system'(不指向具体联邦关系),
-- 原外键 REFERENCES federation_relations(id) 会导致通知插入失败。
ALTER TABLE federation_messages DROP CONSTRAINT IF EXISTS federation_messages_relation_id_fkey;
