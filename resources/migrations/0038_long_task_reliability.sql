CREATE TABLE `job_steps` (
	`job_id` text NOT NULL,
	`step_key` text NOT NULL,
	`source_id` text,
	`output` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `step_key`)
);
--> statement-breakpoint
ALTER TABLE `notes` ADD `user_ai_excluded` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE notes SET user_ai_excluded = ai_excluded;
