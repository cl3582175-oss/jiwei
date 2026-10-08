-- 资料片段全文检索（RAG 关键词召回、资料内搜索）
CREATE VIRTUAL TABLE `segments_fts` USING fts5(`segment_id` UNINDEXED, `source_id` UNINDEXED, `text`, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `segments_fts_ai` AFTER INSERT ON `source_segments` BEGIN
  INSERT INTO `segments_fts`(`segment_id`, `source_id`, `text`) VALUES (new.`id`, new.`source_id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `segments_fts_ad` AFTER DELETE ON `source_segments` BEGIN
  DELETE FROM `segments_fts` WHERE `segment_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `segments_fts_au` AFTER UPDATE OF `text` ON `source_segments` BEGIN
  DELETE FROM `segments_fts` WHERE `segment_id` = old.`id`;
  INSERT INTO `segments_fts`(`segment_id`, `source_id`, `text`) VALUES (new.`id`, new.`source_id`, new.`text`);
END;
