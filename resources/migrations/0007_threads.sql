ALTER TABLE `conversations` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `anchor` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `anchor_parent_id` text;