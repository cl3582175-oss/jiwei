CREATE TABLE `hotword_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hotword_pair_idx` ON `hotword_corrections` (`from`,`to`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`note_id` text,
	`scene` text NOT NULL,
	`status` text NOT NULL,
	`tracks` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`markers` text DEFAULT '[]' NOT NULL,
	`participants` text DEFAULT '[]' NOT NULL,
	`extra_hotwords` text DEFAULT '' NOT NULL,
	`local_only` integer DEFAULT false NOT NULL,
	`preview` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `recordings_source_idx` ON `recordings` (`source_id`);