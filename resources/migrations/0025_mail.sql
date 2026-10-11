CREATE TABLE `mail_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`preset` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 993 NOT NULL,
	`tls` integer DEFAULT true NOT NULL,
	`username` text NOT NULL,
	`secret_enc` blob,
	`enabled` integer DEFAULT true NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `mail_seen` (
	`account_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` text NOT NULL,
	`last_uid` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mailbox`)
);
