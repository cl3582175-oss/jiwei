DROP INDEX `web_pages_url_hash_provider_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `web_pages_url_hash_provider_truncated_uq` ON `web_pages` (`url`,`text_hash`,`provider`,`truncated`);