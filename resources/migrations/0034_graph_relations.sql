ALTER TABLE `links` ADD `status` text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE `links` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `links` ADD `quote` text;--> statement-breakpoint
ALTER TABLE `links` ADD `confidence` real;