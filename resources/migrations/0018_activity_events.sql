CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_events_date_idx` ON `activity_events` (`date`,`kind`);