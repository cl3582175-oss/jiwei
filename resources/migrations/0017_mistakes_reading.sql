CREATE TABLE `mistake_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`mistake_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`solution` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	`flagged` integer DEFAULT false NOT NULL,
	`model` text
);
--> statement-breakpoint
CREATE INDEX `mistake_variants_pool_idx` ON `mistake_variants` (`mistake_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `mistakes` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text,
	`row_id` text,
	`source_kind` text NOT NULL,
	`source_ref` text,
	`asset_id` text,
	`crop_asset_id` text,
	`question` text DEFAULT '' NOT NULL,
	`my_answer` text DEFAULT '' NOT NULL,
	`correct_answer` text DEFAULT '' NOT NULL,
	`solution` text DEFAULT '' NOT NULL,
	`answer_origin` text DEFAULT 'image' NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`cause` text DEFAULT 'unknown' NOT NULL,
	`cause_reason` text DEFAULT '' NOT NULL,
	`concepts` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT 'other' NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`diagnosis_correction` integer DEFAULT false NOT NULL,
	`ingest_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `mistakes_note_idx` ON `mistakes` (`note_id`);--> statement-breakpoint
CREATE INDEX `mistakes_created_idx` ON `mistakes` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mistakes_ingest_idx` ON `mistakes` (`ingest_key`);--> statement-breakpoint
CREATE TABLE `translation_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`text_hash` text NOT NULL,
	`target_language` text NOT NULL,
	`style_version` text NOT NULL,
	`translation` text DEFAULT '' NOT NULL,
	`annotations` text DEFAULT '[]' NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translation_cache_key_idx` ON `translation_cache` (`text_hash`,`target_language`,`style_version`);--> statement-breakpoint
CREATE INDEX `translation_cache_used_idx` ON `translation_cache` (`used_at`);--> statement-breakpoint
ALTER TABLE `cards` ADD `kind` text DEFAULT 'cornell' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `mistake_id` text;