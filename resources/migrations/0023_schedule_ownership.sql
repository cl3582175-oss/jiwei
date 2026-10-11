ALTER TABLE `goal_milestones` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `goal_phases` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `goal_phases` ADD `objective` text;