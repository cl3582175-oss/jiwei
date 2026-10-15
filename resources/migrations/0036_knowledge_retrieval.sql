CREATE TABLE `segment_aliases` (
	`old_id` text PRIMARY KEY NOT NULL,
	`new_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `segment_aliases_source_idx` ON `segment_aliases` (`source_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_pages` (
	`source_id` text NOT NULL,
	`page` integer NOT NULL,
	`need` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`engine` text,
	`text` text,
	`blocks` text,
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `page`, `need`)
);
--> statement-breakpoint
INSERT INTO `__new_source_pages`("source_id", "page", "need", "status", "engine", "text", "blocks", "error", "updated_at") SELECT "source_id", "page", "need", "status", "engine", "text", "blocks", "error", "updated_at" FROM `source_pages`;--> statement-breakpoint
DROP TABLE `source_pages`;--> statement-breakpoint
ALTER TABLE `__new_source_pages` RENAME TO `source_pages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `source_segments` ADD `heading` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `parse_version` integer DEFAULT 0 NOT NULL;