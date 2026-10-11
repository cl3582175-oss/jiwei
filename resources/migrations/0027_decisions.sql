CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`memo` text,
	`weights` text,
	`choice` text,
	`expectation` text,
	`review_at` integer,
	`outcome` text,
	`accuracy` integer,
	`lesson` text,
	`goal_id` text,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `decisions_review_idx` ON `decisions` (`status`,`review_at`);