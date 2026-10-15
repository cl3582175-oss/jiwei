CREATE TABLE `chat_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`instructions` text DEFAULT '' NOT NULL,
	`memory` text DEFAULT 'default' NOT NULL,
	`library_scope` text DEFAULT 'all' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `project_sources` (
	`project_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `item_type`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `project_sources_item_idx` ON `project_sources` (`item_type`,`item_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);