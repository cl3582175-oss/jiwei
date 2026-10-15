CREATE TABLE `job_steps` (
	`job_id` text NOT NULL,
	`step_key` text NOT NULL,
	`source_id` text,
	`output` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `step_key`)
);
--> statement-breakpoint
CREATE TABLE `released_attachments` (
	`source_id` text PRIMARY KEY NOT NULL,
	`released_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notes` ADD `user_ai_excluded` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE notes SET user_ai_excluded = ai_excluded;
--> statement-breakpoint
INSERT OR IGNORE INTO released_attachments(source_id,released_at) SELECT DISTINCT ca.source_id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM conversation_attachments ca JOIN sources s ON s.id=ca.source_id WHERE s.space='library';
