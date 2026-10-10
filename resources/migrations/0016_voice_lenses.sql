CREATE TABLE `derivation_landings` (
	`id` text PRIMARY KEY NOT NULL,
	`derivation_id` text NOT NULL,
	`note_id` text,
	`proposal_id` text,
	`undo_proposal_id` text,
	`status` text NOT NULL,
	`items` text NOT NULL,
	`objects` text DEFAULT '[]' NOT NULL,
	`blocks` text DEFAULT '[]' NOT NULL,
	`applied_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `landings_derivation_idx` ON `derivation_landings` (`derivation_id`);--> statement-breakpoint
CREATE TABLE `derivations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`lens` text NOT NULL,
	`lens_title` text NOT NULL,
	`lens_hash` text NOT NULL,
	`params` text NOT NULL,
	`landing` text NOT NULL,
	`model` text NOT NULL,
	`transcript_revision` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`stats` text,
	`summary` text DEFAULT '' NOT NULL,
	`job_id` text,
	`run_after` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `derivations_source_idx` ON `derivations` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scene` text NOT NULL,
	`category_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
ALTER TABLE `actions` ADD `owner_person_id` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `owner_name` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `insights` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `scene_guess` text;