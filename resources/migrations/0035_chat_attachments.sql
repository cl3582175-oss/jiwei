CREATE TABLE `conversation_attachments` (
	`conversation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`message_id` text,
	`full_text_sent` integer DEFAULT false NOT NULL,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_source_idx` ON `conversation_attachments` (`source_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `space` text DEFAULT 'library' NOT NULL;