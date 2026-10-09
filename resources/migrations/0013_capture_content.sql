CREATE TABLE `asset_texts` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`engine` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_asset_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`block_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_asset_blocks_note_idx` ON `note_asset_blocks` (`note_id`);--> statement-breakpoint
CREATE INDEX `note_asset_blocks_asset_idx` ON `note_asset_blocks` (`asset_id`);