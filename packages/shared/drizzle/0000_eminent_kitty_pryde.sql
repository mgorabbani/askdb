CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`insight` text NOT NULL,
	`collection` text,
	`category` text DEFAULT 'tip' NOT NULL,
	`exampleQuery` text,
	`useCount` integer DEFAULT 1 NOT NULL,
	`lastConfirmedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`connectionId` text NOT NULL,
	`apiKeyId` text NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`apiKeyId`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`keyHash` text NOT NULL,
	`label` text,
	`revokedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_keyHash_unique` ON `api_keys` (`keyHash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`query` text,
	`collection` text,
	`executionMs` integer DEFAULT 0 NOT NULL,
	`docCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`connectionId` text NOT NULL,
	`apiKeyId` text NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`apiKeyId`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`outcome` text DEFAULT 'info' NOT NULL,
	`userId` text,
	`clientId` text,
	`ipAddress` text,
	`userAgent` text,
	`details` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`dbType` text DEFAULT 'mongodb' NOT NULL,
	`databaseName` text DEFAULT '' NOT NULL,
	`connectionString` text NOT NULL,
	`sandboxContainerId` text,
	`sandboxPort` integer,
	`sandboxPassword` text,
	`syncStatus` text DEFAULT 'IDLE' NOT NULL,
	`syncError` text,
	`lastSyncAt` integer,
	`syncInterval` text DEFAULT 'daily' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tokenHash` text NOT NULL,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`connectionId` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`resource` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_tokens_tokenHash_unique` ON `oauth_access_tokens` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`codeHash` text NOT NULL,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`connectionId` text NOT NULL,
	`redirectUri` text NOT NULL,
	`codeChallenge` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`resource` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_authorization_codes_codeHash_unique` ON `oauth_authorization_codes` (`codeHash`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`encryptedClient` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tokenHash` text NOT NULL,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`connectionId` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`resource` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`familyId` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_tokens_tokenHash_unique` ON `oauth_refresh_tokens` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `query_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`description` text NOT NULL,
	`exampleQuery` text,
	`collection` text,
	`frequency` integer DEFAULT 1 NOT NULL,
	`lastUsedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`connectionId` text NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schema_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fieldType` text NOT NULL,
	`sampleValue` text,
	`isVisible` integer DEFAULT true NOT NULL,
	`piiConfidence` text DEFAULT 'NONE' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`tableId` text NOT NULL,
	FOREIGN KEY (`tableId`) REFERENCES `schema_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schema_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceTableId` text NOT NULL,
	`sourceField` text NOT NULL,
	`targetTableId` text NOT NULL,
	`targetField` text DEFAULT '_id' NOT NULL,
	`relationType` text DEFAULT 'belongsTo' NOT NULL,
	`confidence` text DEFAULT 'AUTO' NOT NULL,
	`createdAt` integer NOT NULL,
	`connectionId` text NOT NULL,
	FOREIGN KEY (`sourceTableId`) REFERENCES `schema_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`targetTableId`) REFERENCES `schema_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schema_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`docCount` integer DEFAULT 0 NOT NULL,
	`isVisible` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`connectionId` text NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
