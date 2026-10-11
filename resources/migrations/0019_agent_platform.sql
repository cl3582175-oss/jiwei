CREATE TABLE `agent_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`caller` text NOT NULL,
	`tool` text NOT NULL,
	`level` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`conversation_id` text
);
--> statement-breakpoint
CREATE INDEX `agent_audit_at_idx` ON `agent_audit` (`at`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`date` text NOT NULL,
	`purpose` text NOT NULL,
	`caller` text NOT NULL,
	`provider_id` text,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real
);
--> statement-breakpoint
CREATE INDEX `ai_usage_date_idx` ON `ai_usage` (`date`);--> statement-breakpoint
CREATE TABLE `mcp_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`cwd` text,
	`env_enc` blob,
	`url` text,
	`headers_enc` blob,
	`oauth_enc` blob,
	`enabled` integer DEFAULT true NOT NULL,
	`tool_policies` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
