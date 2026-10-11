CREATE TABLE `work_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`ref` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `work_sources_work_idx` ON `work_sources` (`work_id`);--> statement-breakpoint
CREATE INDEX `work_sources_ref_idx` ON `work_sources` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'cowrite' NOT NULL,
	`stage` text DEFAULT 'topic' NOT NULL,
	`goal_id` text,
	`content` text,
	`polish` text,
	`exports` text DEFAULT '[]' NOT NULL,
	`published_where` text,
	`published_at` integer,
	`retrospective` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `works_updated_idx` ON `works` (`updated_at`);