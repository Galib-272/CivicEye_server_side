-- CreateEnum
CREATE TYPE "ModerationCaseStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModerationTargetType" AS ENUM ('REPORT', 'PUBLIC_UPDATE');

-- CreateEnum
CREATE TYPE "ModerationReason" AS ENUM ('SPAM_OR_FAKE', 'OFFENSIVE', 'PERSONAL_INFORMATION', 'MISLEADING_PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "ModerationActionKind" AS ENUM ('START_REVIEW', 'HIDE_REPORT', 'RESTORE_REPORT', 'HIDE_UPDATE', 'REQUEST_CORRECTION', 'WARN_USER', 'SUSPEND_USER', 'RESOLVE', 'DISMISS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'REPORT_HIDDEN';
ALTER TYPE "NotificationType" ADD VALUE 'CORRECTION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATION_WARNING';

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "moderation_hidden_at" TIMESTAMPTZ(3),
ADD COLUMN     "moderation_hidden_reason" VARCHAR(1000);

-- CreateTable
CREATE TABLE "moderation_cases" (
    "id" UUID NOT NULL,
    "target_type" "ModerationTargetType" NOT NULL,
    "report_id" UUID NOT NULL,
    "public_update_id" UUID,
    "status" "ModerationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "flag_count" INTEGER NOT NULL DEFAULT 0,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "moderation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_flags" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "organization_id" UUID,
    "reason" "ModerationReason" NOT NULL,
    "details" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "kind" "ModerationActionKind" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "message" VARCHAR(1000),
    "target_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "moderation_cases_status_created_at_idx" ON "moderation_cases"("status", "created_at");

-- CreateIndex
CREATE INDEX "moderation_cases_report_id_idx" ON "moderation_cases"("report_id");

-- CreateIndex
CREATE INDEX "moderation_flags_created_at_idx" ON "moderation_flags"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_flags_case_id_reporter_id_key" ON "moderation_flags"("case_id", "reporter_id");

-- CreateIndex
CREATE INDEX "moderation_actions_case_id_created_at_idx" ON "moderation_actions"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_actions_target_user_id_created_at_idx" ON "moderation_actions"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "reports_submitted_at_idx" ON "reports"("submitted_at");

-- CreateIndex
CREATE INDEX "report_status_history_to_status_created_at_idx" ON "report_status_history"("to_status", "created_at");

-- CreateIndex
CREATE INDEX "report_routing_decisions_organization_id_created_at_idx" ON "report_routing_decisions"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "report_review_decisions_organization_id_created_at_idx" ON "report_review_decisions"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "report_transfers_to_organization_id_created_at_idx" ON "report_transfers"("to_organization_id", "created_at");

-- CreateIndex
CREATE INDEX "report_assignments_organization_id_completed_at_idx" ON "report_assignments"("organization_id", "completed_at");

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_public_update_id_fkey" FOREIGN KEY ("public_update_id") REFERENCES "report_public_updates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_flags" ADD CONSTRAINT "moderation_flags_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "moderation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_flags" ADD CONSTRAINT "moderation_flags_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "moderation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one open case per piece of content: new flags join it.
CREATE UNIQUE INDEX "moderation_cases_one_open_per_target"
  ON "moderation_cases" ("report_id", COALESCE("public_update_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED');
-- A public update case names its update; a report case does not.
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_target_check"
  CHECK (("target_type" = 'PUBLIC_UPDATE') = ("public_update_id" IS NOT NULL));
-- Closed cases say when they closed, open ones do not.
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_closed_check"
  CHECK (("status" IN ('RESOLVED', 'DISMISSED')) = ("closed_at" IS NOT NULL));
-- Hidden reports say why.
ALTER TABLE "reports" ADD CONSTRAINT "reports_moderation_hidden_check"
  CHECK (("moderation_hidden_at" IS NULL) = ("moderation_hidden_reason" IS NULL));
