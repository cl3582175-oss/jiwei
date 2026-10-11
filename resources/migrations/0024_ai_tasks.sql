CREATE TABLE `ai_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`delayed` integer DEFAULT false NOT NULL,
	`trigger_info` text DEFAULT '{}' NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`summary` text,
	`result_refs` text DEFAULT '[]' NOT NULL,
	`error` text,
	`conversation_id` text
);
--> statement-breakpoint
CREATE INDEX `ai_task_runs_task_idx` ON `ai_task_runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `ai_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`instruction` text NOT NULL,
	`trigger` text NOT NULL,
	`tools` text NOT NULL,
	`outputs` text NOT NULL,
	`budget_per_run` real,
	`enabled` integer DEFAULT true NOT NULL,
	`recipe` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
