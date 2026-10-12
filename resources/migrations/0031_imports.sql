CREATE TABLE `import_items` (
	`run_id` text NOT NULL,
	`source_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`note_id` text,
	`status` text NOT NULL,
	`message` text,
	`complete` integer DEFAULT false NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`run_id`, `source_key`)
);
--> statement-breakpoint
CREATE INDEX `import_items_note_idx` ON `import_items` (`note_id`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`root_label` text NOT NULL,
	`root_hash` text NOT NULL,
	`options` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `import_runs_root_idx` ON `import_runs` (`root_hash`);--> statement-breakpoint
CREATE TABLE `import_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
DELETE FROM `meta` WHERE `key` LIKE 'import.tmp.%';
