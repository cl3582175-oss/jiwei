ALTER TABLE `cards` ADD `learning_steps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `review_excluded` integer DEFAULT false NOT NULL;