CREATE TABLE `source_pages` (
	`source_id` text NOT NULL,
	`page` integer NOT NULL,
	`need` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`engine` text,
	`text` text,
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `page`)
);
