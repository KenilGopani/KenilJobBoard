CREATE TABLE `discovered_jobs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`remote_type` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text NOT NULL,
	`posted_at` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_interval` text,
	`employment_type` text,
	`description` text,
	`provenance` text NOT NULL,
	`raw_source` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_run_id` text,
	`promoted_job_id` text,
	`status_updated_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `discovered_jobs_user_status_seen` ON `discovered_jobs` (`user_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `discovery_runs` (
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`adapter` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`metrics` text NOT NULL,
	`jobs_received` integer DEFAULT 0 NOT NULL,
	`jobs_new` integer DEFAULT 0 NOT NULL,
	`imported_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `run_id`)
);
