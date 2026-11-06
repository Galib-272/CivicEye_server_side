-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'DECLINED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentEventKind" AS ENUM ('ASSIGNED', 'ACCEPTED', 'DECLINED', 'STARTED', 'PROGRESS', 'COMPLETED', 'APPROVED', 'REJECTED', 'MORE_EVIDENCE_NEEDED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VerificationOutcome" AS ENUM ('APPROVED', 'REJECTED', 'NEEDS_MORE_EVIDENCE');

-- AlterEnum
ALTER TYPE "MediaPurpose" ADD VALUE 'WORK_PHOTO';

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "available" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "report_media" ADD COLUMN     "assignment_id" UUID;

-- CreateTable
CREATE TABLE "report_assignments" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "state" "AssignmentState" NOT NULL DEFAULT 'PENDING',
    "note" VARCHAR(1000),
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" VARCHAR(1000),

    CONSTRAINT "report_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_events" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "actor_id" UUID,
    "kind" "AssignmentEventKind" NOT NULL,
    "message" VARCHAR(2000),
    "media_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "completion_submissions" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "media_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_verifications" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "verifier_id" UUID NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citizen_feedback" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "citizen_id" UUID NOT NULL,
    "fixed" BOOLEAN NOT NULL,
    "comment" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citizen_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_assignments_report_id_assigned_at_idx" ON "report_assignments"("report_id", "assigned_at");

-- CreateIndex
CREATE INDEX "report_assignments_worker_id_state_idx" ON "report_assignments"("worker_id", "state");

-- CreateIndex
CREATE INDEX "report_assignments_organization_id_state_idx" ON "report_assignments"("organization_id", "state");

-- CreateIndex
CREATE INDEX "assignment_events_assignment_id_created_at_idx" ON "assignment_events"("assignment_id", "created_at");

-- CreateIndex
CREATE INDEX "completion_submissions_assignment_id_created_at_idx" ON "completion_submissions"("assignment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_verifications_submission_id_key" ON "work_verifications"("submission_id");

-- CreateIndex
CREATE INDEX "work_verifications_report_id_created_at_idx" ON "work_verifications"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "citizen_feedback_report_id_created_at_idx" ON "citizen_feedback"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "report_media_assignment_id_idx" ON "report_media"("assignment_id");

-- AddForeignKey
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "report_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_assignments" ADD CONSTRAINT "report_assignments_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_assignments" ADD CONSTRAINT "report_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_assignments" ADD CONSTRAINT "report_assignments_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_assignments" ADD CONSTRAINT "report_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "report_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_submissions" ADD CONSTRAINT "completion_submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "report_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_submissions" ADD CONSTRAINT "completion_submissions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_verifications" ADD CONSTRAINT "work_verifications_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_verifications" ADD CONSTRAINT "work_verifications_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "report_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_verifications" ADD CONSTRAINT "work_verifications_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "completion_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_verifications" ADD CONSTRAINT "work_verifications_verifier_id_fkey" FOREIGN KEY ("verifier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_feedback" ADD CONSTRAINT "citizen_feedback_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_feedback" ADD CONSTRAINT "citizen_feedback_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written rules (not expressible in the Prisma schema) ─────────────────

-- At most one active assignment per report: two workers can never be assigned by accident.
CREATE UNIQUE INDEX "report_assignments_one_active_per_report"
  ON "report_assignments" ("report_id")
  WHERE "state" IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED');

-- Ended assignments record when and why.
ALTER TABLE "report_assignments" ADD CONSTRAINT "report_assignments_ended_check" CHECK (
  ("state" IN ('DECLINED', 'RETURNED', 'CANCELLED')) = ("ended_at" IS NOT NULL AND "end_reason" IS NOT NULL)
  OR ("state" = 'VERIFIED' AND "ended_at" IS NOT NULL));

-- Who, what and for whom never change; assignments are never deleted.
CREATE FUNCTION "report_assignments_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."report_id" IS DISTINCT FROM OLD."report_id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."worker_id" IS DISTINCT FROM OLD."worker_id"
     OR NEW."assigned_by_id" IS DISTINCT FROM OLD."assigned_by_id"
     OR NEW."assigned_at" IS DISTINCT FROM OLD."assigned_at"
     OR OLD."state" IN ('VERIFIED', 'DECLINED', 'RETURNED', 'CANCELLED') THEN
    RAISE EXCEPTION 'report_assignments: only the state of an open assignment may change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "report_assignments_protect"
  BEFORE UPDATE OR DELETE ON "report_assignments"
  FOR EACH ROW EXECUTE FUNCTION "report_assignments_protect"();
CREATE TRIGGER "report_assignments_no_truncate"
  BEFORE TRUNCATE ON "report_assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();

-- A photo belongs to a report or to an assignment, never both.
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_single_owner_check" CHECK (
  "report_id" IS NULL OR "assignment_id" IS NULL);

ALTER TABLE "completion_submissions" ADD CONSTRAINT "completion_submissions_check" CHECK (
  length(btrim("description")) > 0 AND cardinality("media_ids") BETWEEN 1 AND 5);
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_media_check" CHECK (
  cardinality("media_ids") <= 5);
-- Anything other than approval needs a reason.
ALTER TABLE "work_verifications" ADD CONSTRAINT "work_verifications_reason_check" CHECK (
  "outcome" = 'APPROVED' OR length(btrim(coalesce("reason", ''))) > 0);

-- Append-only records: no UPDATE, DELETE or TRUNCATE.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assignment_events', 'completion_submissions',
    'work_verifications', 'citizen_feedback']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"()', t || '_no_update_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"()', t || '_no_truncate', t);
  END LOOP;
END $$;
