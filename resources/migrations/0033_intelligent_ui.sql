CREATE TABLE `ui_states` (
	`message_id` text NOT NULL,
	`component_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `component_id`)
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `ui_text` text;