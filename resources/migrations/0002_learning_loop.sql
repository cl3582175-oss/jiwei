CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`done_at` integer,
	`review_id` text,
	`goal_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`block_id` text NOT NULL,
	`due` integer NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`elapsed_days` integer DEFAULT 0 NOT NULL,
	`scheduled_days` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`last_review` integer,
	`suspended` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `cards_due_idx` ON `cards` (`due`);--> statement-breakpoint
CREATE UNIQUE INDEX `cards_block_idx` ON `cards` (`block_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`target_at` integer,
	`category_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `insight_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`insight_id` text NOT NULL,
	`version` integer NOT NULL,
	`statement` text NOT NULL,
	`confidence` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `insight_versions_idx` ON `insight_versions` (`insight_id`,`version`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`statement` text NOT NULL,
	`confidence` text DEFAULT 'hypothesis' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`review_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`result` text,
	`run_after` integer NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_dedupe_idx` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `learner_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`title` text NOT NULL,
	`ops` text NOT NULL,
	`op_status` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`sources` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `proposals_note_idx` ON `proposals` (`note_id`,`status`);--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`rating` integer NOT NULL,
	`state` integer NOT NULL,
	`due` integer NOT NULL,
	`stability` real NOT NULL,
	`difficulty` real NOT NULL,
	`elapsed_days` integer NOT NULL,
	`scheduled_days` integer NOT NULL,
	`duration_ms` integer,
	`reviewed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_logs_card_idx` ON `review_logs` (`card_id`,`reviewed_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text,
	`kind` text NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`scope` text,
	`template` text DEFAULT 'grai' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `reviews_period_idx` ON `reviews` (`kind`,`period_start`);--> statement-breakpoint
CREATE TABLE `source_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`locator` text NOT NULL,
	`text` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `segments_source_idx` ON `source_segments` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_asset_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
ALTER TABLE `blocks` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `kind` text DEFAULT 'cornell' NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `ai_word_count` integer DEFAULT 0 NOT NULL;