CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`includes_history` integer DEFAULT false NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`host_pattern` text DEFAULT '*' NOT NULL,
	`cert_pem` text,
	`key_ref` text,
	`pfx_ref` text,
	`passphrase_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`request_id` text,
	`request_name` text NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`status_code` integer,
	`duration_ms` integer,
	`passed` integer DEFAULT true NOT NULL,
	`error` text,
	`tests_json` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `collection_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_collection_run_items_run` ON `collection_run_items` (`run_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `collection_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`collection_id` text,
	`collection_name` text NOT NULL,
	`environment_id` text,
	`iterations` integer DEFAULT 1 NOT NULL,
	`delay_ms` integer DEFAULT 0 NOT NULL,
	`stop_on_failure` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_requests` integer DEFAULT 0 NOT NULL,
	`passed_tests` integer DEFAULT 0 NOT NULL,
	`failed_tests` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`summary_json` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_collection_runs_workspace` ON `collection_runs` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `collection_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`initial_value` text DEFAULT '' NOT NULL,
	`current_value` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`collection_id` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_collection_variables_collection` ON `collection_variables` (`collection_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`uid` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`postman_schema_version` text,
	`source_metadata_json` text DEFAULT '{}' NOT NULL,
	`auth_json` text DEFAULT '{"type":"none","params":{}}' NOT NULL,
	`scripts_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_collections_workspace` ON `collections` (`workspace_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_collections_name` ON `collections` (`name`);--> statement-breakpoint
CREATE TABLE `cookies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`name` text NOT NULL,
	`value_ref` text NOT NULL,
	`host_only` integer DEFAULT true NOT NULL,
	`secure` integer DEFAULT false NOT NULL,
	`http_only` integer DEFAULT false NOT NULL,
	`same_site` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cookies_identity` ON `cookies` (`workspace_id`,`domain`,`path`,`name`);--> statement-breakpoint
CREATE INDEX `idx_cookies_domain` ON `cookies` (`domain`);--> statement-breakpoint
CREATE TABLE `environment_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`initial_value` text DEFAULT '' NOT NULL,
	`current_value` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`environment_id` text NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_environment_variables_env` ON `environment_variables` (`environment_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`is_production` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_environments_workspace` ON `environments` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `folder_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`initial_value` text DEFAULT '' NOT NULL,
	`current_value` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`folder_id` text NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_folder_variables_folder` ON `folder_variables` (`folder_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`parent_folder_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`auth_json` text DEFAULT '{"type":"inherit","params":{}}' NOT NULL,
	`scripts_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_folders_collection` ON `folders` (`collection_id`,`parent_folder_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `global_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`initial_value` text DEFAULT '' NOT NULL,
	`current_value` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_global_variables_workspace` ON `global_variables` (`workspace_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_id` text,
	`environment_id` text,
	`environment_name` text,
	`request_name` text,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`status_code` integer,
	`status_text` text,
	`error_code` text,
	`duration_ms` integer,
	`request_size` integer,
	`response_size` integer,
	`created_at` text NOT NULL,
	`request_snapshot_json` text,
	`response_metadata_json` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_history_workspace_created` ON `history` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_history_url` ON `history` (`url`);--> statement-breakpoint
CREATE INDEX `idx_history_status` ON `history` (`status_code`);--> statement-breakpoint
CREATE INDEX `idx_history_method` ON `history` (`method`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`source_type` text NOT NULL,
	`file_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`collection_id` text,
	`stats_json` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `import_warnings` (
	`id` text PRIMARY KEY NOT NULL,
	`import_job_id` text NOT NULL,
	`severity` text NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`message` text NOT NULL,
	`source_value` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_import_warnings_job` ON `import_warnings` (`import_job_id`);--> statement-breakpoint
CREATE TABLE `request_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`auth_type` text DEFAULT 'inherit' NOT NULL,
	`configuration_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_request_auth_request` ON `request_auth` (`request_id`);--> statement-breakpoint
CREATE TABLE `request_bodies` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`mode` text DEFAULT 'none' NOT NULL,
	`raw_content` text,
	`raw_language` text,
	`content_type` text,
	`file_path` text,
	`form_data_json` text,
	`urlencoded_json` text,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_request_bodies_request` ON `request_bodies` (`request_id`);--> statement-breakpoint
CREATE TABLE `request_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`code` integer DEFAULT 200 NOT NULL,
	`headers_json` text DEFAULT '[]' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`language` text,
	`original_request_json` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_request_examples_request` ON `request_examples` (`request_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `request_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_request_headers_request` ON `request_headers` (`request_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `request_path_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_request_path_variables_request` ON `request_path_variables` (`request_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `request_query_params` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_request_query_params_request` ON `request_query_params` (`request_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `request_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`script_type` text NOT NULL,
	`language` text DEFAULT 'javascript' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_request_scripts_request` ON `request_scripts` (`request_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`folder_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_requests_collection` ON `requests` (`collection_id`,`folder_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_requests_name` ON `requests` (`name`);--> statement-breakpoint
CREATE INDEX `idx_requests_url` ON `requests` (`url`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`blob` blob NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`history_id` text,
	`run_item_id` text,
	`request_id` text,
	`name` text NOT NULL,
	`passed` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`history_id`) REFERENCES `history`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_test_results_history` ON `test_results` (`history_id`);--> statement-breakpoint
CREATE INDEX `idx_test_results_run_item` ON `test_results` (`run_item_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
