CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`asset_id` text,
	`recognized` text DEFAULT '' NOT NULL,
	`recognition_status` text DEFAULT 'none' NOT NULL,
	`origin` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`suggestion` text,
	`filed_to` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `inbox_status_idx` ON `inbox_items` (`status`,`deleted_at`);