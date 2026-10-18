PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_web_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`final_url` text,
	`provider` text DEFAULT 'local' NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
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
INSERT INTO `__new_web_pages`("id", "url", "final_url", "title", "site_name", "published_at", "fetched_at", "method", "lang", "text", "text_hash") SELECT "id", "url", "final_url", "title", "site_name", "published_at", "fetched_at", "method", "lang", "text", "text_hash" FROM `web_pages`;--> statement-breakpoint
DROP TABLE `web_pages`;--> statement-breakpoint
ALTER TABLE `__new_web_pages` RENAME TO `web_pages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `web_pages_url_idx` ON `web_pages` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `web_pages_url_hash_provider_uq` ON `web_pages` (`url`,`text_hash`,`provider`);--> statement-breakpoint
ALTER TABLE `sources` ADD `web_origin` text;
