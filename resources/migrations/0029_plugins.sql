CREATE TABLE `plugin_markets` (
	`name` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`catalog` text,
	`fetched_at` integer,
	`error` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`version` text NOT NULL,
	`previous_version` text,
	`enabled` integer DEFAULT true NOT NULL,
	`capabilities` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets_enc` blob,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_tasks` ADD `plugin_id` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `plugin_id` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `plugin_id` text;