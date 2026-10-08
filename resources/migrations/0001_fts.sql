-- 全文检索：trigram 分词对中文友好（>=3 字子串匹配；更短的查询由应用层回退到 LIKE）
-- 使用独立 FTS 表并以 id 关联，避免 VACUUM 后隐式 rowid 变化导致索引错位
CREATE VIRTUAL TABLE `notes_fts` USING fts5(`note_id` UNINDEXED, `title`, `plain_text`, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ai` AFTER INSERT ON `notes` BEGIN
  INSERT INTO `notes_fts`(`note_id`, `title`, `plain_text`) VALUES (new.`id`, new.`title`, new.`plain_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ad` AFTER DELETE ON `notes` BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE OF `title`, `plain_text` ON `notes` BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = old.`id`;
  INSERT INTO `notes_fts`(`note_id`, `title`, `plain_text`) VALUES (new.`id`, new.`title`, new.`plain_text`);
END;
--> statement-breakpoint
-- 段落级全文检索（RAG 关键词召回）
CREATE VIRTUAL TABLE `blocks_fts` USING fts5(`block_id` UNINDEXED, `note_id` UNINDEXED, `text`, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `blocks_fts_ai` AFTER INSERT ON `blocks` BEGIN
  INSERT INTO `blocks_fts`(`block_id`, `note_id`, `text`) VALUES (new.`id`, new.`note_id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `blocks_fts_ad` AFTER DELETE ON `blocks` BEGIN
  DELETE FROM `blocks_fts` WHERE `block_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `blocks_fts_au` AFTER UPDATE OF `text` ON `blocks` BEGIN
  DELETE FROM `blocks_fts` WHERE `block_id` = old.`id`;
  INSERT INTO `blocks_fts`(`block_id`, `note_id`, `text`) VALUES (new.`id`, new.`note_id`, new.`text`);
END;
