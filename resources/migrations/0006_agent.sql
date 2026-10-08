ALTER TABLE `conversations` ADD `incognito` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `skill` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `steps` text;