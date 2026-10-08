-- 全文检索：trigram 分词对中文友好（>=3 字子串匹配；更短的查询由应用层回退到 LIKE）
-- 使用独立 FTS 表并以 note_id 关联，避免 VACUUM 后隐式 rowid 变化导致索引错位
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
