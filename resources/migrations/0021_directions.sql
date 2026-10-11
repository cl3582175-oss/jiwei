CREATE TABLE `plan_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`goal_id` text,
	`phase_id` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`feed_id` text,
	`uid` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `plan_events_range_idx` ON `plan_events` (`start_at`,`end_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_events_feed_uid_idx` ON `plan_events` (`feed_id`,`uid`,`start_at`);--> statement-breakpoint
ALTER TABLE `actions` ADD `phase_id` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `kind` text DEFAULT 'skill' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `start_at` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `weekly_minutes` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `weekday_minutes` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `color` text;