CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_me` integer DEFAULT false NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`merged_into` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `recording_speakers` (
	`source_id` text NOT NULL,
	`label` text NOT NULL,
	`person_id` text,
	`origin` text DEFAULT 'auto' NOT NULL,
	`centroid` blob,
	`confidence` real,
	`skipped` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`source_id`, `label`)
);
--> statement-breakpoint
CREATE TABLE `voiceprints` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`model` text NOT NULL,
	`source_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voiceprints_person_idx` ON `voiceprints` (`person_id`);