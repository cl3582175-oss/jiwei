CREATE TABLE `activity` (
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_links` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_id`, `to_id`)
);
--> statement-breakpoint
CREATE TABLE `note_sources` (
	`note_id` text NOT NULL,
	`source_id` text NOT NULL,
	`anchor` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_sources_note_idx` ON `note_sources` (`note_id`);--> statement-breakpoint
CREATE INDEX `note_sources_source_idx` ON `note_sources` (`source_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`category_id` text,
	`cue` text NOT NULL,
	`content` text NOT NULL,
	`summary` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `notes_category_idx` ON `notes` (`category_id`);--> statement-breakpoint
CREATE INDEX `notes_deleted_idx` ON `notes` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text,
	`original_name` text,
	`mime` text,
	`size` integer DEFAULT 0 NOT NULL,
	`url` text,
	`category_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `sources_category_idx` ON `sources` (`category_id`);--> statement-breakpoint
CREATE INDEX `sources_deleted_idx` ON `sources` (`deleted_at`);