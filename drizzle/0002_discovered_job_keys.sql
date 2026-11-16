CREATE TABLE `discovered_job_keys` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`job_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `discovered_job_keys_user_job` ON `discovered_job_keys` (`user_id`,`job_id`);