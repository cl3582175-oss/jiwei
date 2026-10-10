CREATE TABLE `known_words` (
	`word` text PRIMARY KEY NOT NULL,
	`added_at` integer NOT NULL,
	`source` text DEFAULT 'recognize' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vocabulary_profile` (
	`id` text PRIMARY KEY DEFAULT 'self' NOT NULL,
	`vocab_threshold` integer DEFAULT 6000 NOT NULL,
	`vocab_history` text DEFAULT '[]' NOT NULL,
	`pending_signals` text DEFAULT '[]' NOT NULL,
	`initialized` integer DEFAULT false NOT NULL
);
