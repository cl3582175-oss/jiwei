CREATE TABLE `retrieval_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`date` text NOT NULL,
	`backend` text NOT NULL,
	`kind` text NOT NULL,
	`purpose` text NOT NULL,
	`run_id` text,
	`conversation_id` text,
	`ok` integer NOT NULL,
	`cached` integer NOT NULL,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `retrieval_calls_date_idx` ON `retrieval_calls` (`date`);--> statement-breakpoint
CREATE TABLE `search_backends` (
	`id` text PRIMARY KEY NOT NULL,
	`key_enc` blob,
	`key_provider_id` text,
	`base_url` text,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `web_page_refs` (
	`page_id` text NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`page_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `web_page_refs_conv_idx` ON `web_page_refs` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `web_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`final_url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`site_name` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`method` text NOT NULL,
	`lang` text,
	`text` text NOT NULL,
	`text_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_pages_url_idx` ON `web_pages` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `web_pages_url_hash_uq` ON `web_pages` (`url`,`text_hash`);--> statement-breakpoint
CREATE TABLE `web_search_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`backend` text NOT NULL,
	`results` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_search_cache_expires_idx` ON `web_search_cache` (`expires_at`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `web` text;