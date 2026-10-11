CREATE TABLE `goal_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`phase_id` text,
	`title` text NOT NULL,
	`at` integer NOT NULL,
	`done_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `goal_milestones_goal_idx` ON `goal_milestones` (`goal_id`);--> statement-breakpoint
CREATE TABLE `goal_phases` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`title` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`note_ids` text DEFAULT '[]' NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `goal_phases_goal_idx` ON `goal_phases` (`goal_id`);--> statement-breakpoint
CREATE TABLE `ics_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`color` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fetched_at` integer,
	`etag` text,
	`last_modified` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
