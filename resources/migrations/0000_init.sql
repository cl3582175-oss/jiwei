CREATE TABLE `activity` (
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`selector` text NOT NULL,
	`motivation` text NOT NULL,
	`body` text,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `annotations_target_idx` ON `annotations` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`mime` text,
	`ext` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`kind` text NOT NULL,
	`section` text NOT NULL,
	`row_id` text,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `blocks_note_idx` ON `blocks` (`note_id`,`position`);--> statement-breakpoint
CREATE INDEX `blocks_row_idx` ON `blocks` (`row_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`from_block_id` text,
	`to_type` text NOT NULL,
	`to_id` text NOT NULL,
	`to_selector` text,
	`relation` text DEFAULT 'reference' NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `links_from_idx` ON `links` (`from_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `links_to_idx` ON `links` (`to_type`,`to_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_assets` (
	`note_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`note_id`, `asset_id`)
);
--> statement-breakpoint
CREATE INDEX `note_assets_asset_idx` ON `note_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `note_docs` (
	`note_id` text PRIMARY KEY NOT NULL,
	`state` blob NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`title` text NOT NULL,
	`state` blob NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_revisions_note_idx` ON `note_revisions` (`note_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `note_updates` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` text NOT NULL,
	`update` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_updates_note_idx` ON `note_updates` (`note_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`category_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`learned_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`superseded_by` text,
	`ai_excluded` integer DEFAULT false NOT NULL,
	`doc_version` integer DEFAULT 1 NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`edited_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `notes_category_idx` ON `notes` (`category_id`);--> statement-breakpoint
CREATE INDEX `notes_deleted_idx` ON `notes` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `notes_edited_idx` ON `notes` (`edited_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`asset_id` text,
	`original_name` text,
	`url` text,
	`author` text,
	`published_at` integer,
	`accessed_at` integer NOT NULL,
	`category_id` text,
	`ai_excluded` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `sources_category_idx` ON `sources` (`category_id`);--> statement-breakpoint
CREATE INDEX `sources_deleted_idx` ON `sources` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `sources_asset_idx` ON `sources` (`asset_id`);--> statement-breakpoint
CREATE TABLE `taggings` (
	`tag_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tag_id`, `entity_type`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `taggings_entity_idx` ON `taggings` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_idx` ON `tags` (`name`);