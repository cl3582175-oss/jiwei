DROP TRIGGER `segments_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `segments_fts_ad`;
--> statement-breakpoint
DROP TRIGGER `segments_fts_au`;
--> statement-breakpoint
DROP TABLE `segments_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `segments_fts` USING fts5(`segment_id` UNINDEXED, `source_id` UNINDEXED, `text`, `heading`, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `segments_fts_ai` AFTER INSERT ON `source_segments` BEGIN
  INSERT INTO `segments_fts`(`segment_id`, `source_id`, `text`, `heading`) VALUES (new.`id`, new.`source_id`, new.`text`, new.`heading`);
END;
--> statement-breakpoint
CREATE TRIGGER `segments_fts_ad` AFTER DELETE ON `source_segments` BEGIN
  DELETE FROM `segments_fts` WHERE `segment_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `segments_fts_au` AFTER UPDATE OF `text`, `heading` ON `source_segments` BEGIN
  DELETE FROM `segments_fts` WHERE `segment_id` = old.`id`;
  INSERT INTO `segments_fts`(`segment_id`, `source_id`, `text`, `heading`) VALUES (new.`id`, new.`source_id`, new.`text`, new.`heading`);
END;
--> statement-breakpoint
INSERT INTO `segments_fts`(`segment_id`, `source_id`, `text`, `heading`) SELECT `id`, `source_id`, `text`, `heading` FROM `source_segments`;
