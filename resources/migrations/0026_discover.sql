CREATE TABLE `discover_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	`topic` text NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`author` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`score` text,
	`reason` text,
	`related` text DEFAULT '[]' NOT NULL,
	`gap` text,
	`minutes` integer,
	`picked_at` integer,
	`later_at` integer,
	`audio_url` text,
	`pdf_url` text,
	`inbox_id` text,
	`remedy_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_items_url_idx` ON `feed_items` (`url`);--> statement-breakpoint
CREATE INDEX `feed_items_status_idx` ON `feed_items` (`status`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`goal_id` text,
	`last_fetched_at` integer,
	`etag` text,
	`last_modified` text,
	`error` text,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `search_connections` (
	`service` text PRIMARY KEY NOT NULL,
	`key_enc` blob,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
