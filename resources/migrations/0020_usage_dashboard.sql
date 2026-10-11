ALTER TABLE `ai_usage` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `conversation_id` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `provider_name` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `saved` real DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_usage_run_idx` ON `ai_usage` (`run_id`);