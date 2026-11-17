-- Custom SQL migration file, put your code below! --
-- Only a never-bound, unsigned first claim could still change hands under the old lease rules; release those names. Every other name stays bound to its address forever. The exact binding time was not recorded, so the last claim activity stands in for it.
INSERT INTO "usernames" ("username", "address", "boundAt")
SELECT "username", "address", "claimedAt" FROM "wallets"
WHERE NOT ("status" = 'claimed' AND NOT "ownershipBound" AND "attemptHash" IS NULL);
--> statement-breakpoint
UPDATE "wallets" SET "status" = 'opening' WHERE "status" = 'claimed';
--> statement-breakpoint
-- Recovered rows now drop their spent opening and recovery data when they are marked recovered, not when they reopen.
UPDATE "wallets" SET "attemptEnvelope" = NULL, "attemptHash" = NULL, "attemptExpiresAt" = NULL, "recoveryDraft" = NULL, "recoveryEnvelope" = NULL, "recoveryHash" = NULL, "recoverySequence" = NULL, "recoveryMinTime" = NULL, "recoveryMaxTime" = NULL WHERE "status" = 'recovered';
--> statement-breakpoint
-- A reopening wallet is a recovered wallet whose repair is in progress; its attempt data is kept.
UPDATE "wallets" SET "status" = 'recovered' WHERE "status" = 'reopening';
