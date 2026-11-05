CREATE TABLE "SpendBucket" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "usedMicroUsd" BIGINT NOT NULL DEFAULT 0 CHECK ("usedMicroUsd" >= 0)
);
CREATE TABLE "SpendReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "model" TEXT NOT NULL,
  "maxMicroUsd" BIGINT NOT NULL CHECK ("maxMicroUsd" > 0),
  "actualMicroUsd" BIGINT CHECK ("actualMicroUsd" >= 0),
  "status" TEXT NOT NULL DEFAULT 'held' CHECK ("status" IN ('held', 'settled')),
  "bucketIds" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3)
);
CREATE TABLE "FinancialState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "blockedReason" TEXT
);
CREATE TABLE "Note" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "text" TEXT NOT NULL CHECK (octet_length("text") BETWEEN 1 AND 4096),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Note_requestId_key" ON "Note"("requestId");
CREATE INDEX "Note_ownerId_createdAt_idx" ON "Note"("ownerId", "createdAt");
CREATE TABLE "Reminder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "text" TEXT NOT NULL CHECK (octet_length("text") BETWEEN 1 AND 4096),
  "channel" TEXT NOT NULL CHECK ("channel" IN ('telegram', 'whatsapp')),
  "recipient" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'claimed', 'accepted', 'delivered', 'failed', 'cancelled', 'unknown', 'missed')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "leaseUntil" TIMESTAMP(3),
  "leaseId" TEXT,
  "providerId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Reminder_requestId_key" ON "Reminder"("requestId");
CREATE INDEX "Reminder_status_nextAttemptAt_idx" ON "Reminder"("status", "nextAttemptAt");
CREATE INDEX "Reminder_ownerId_dueAt_idx" ON "Reminder"("ownerId", "dueAt");
