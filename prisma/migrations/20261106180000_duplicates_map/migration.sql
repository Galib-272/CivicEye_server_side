-- CreateEnum
CREATE TYPE "DuplicateCandidateStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "DuplicateDecisionKind" AS ENUM ('CONFIRMED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_DUPLICATE';

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "duplicate_of_id" UUID;

-- CreateTable
CREATE TABLE "duplicate_candidates" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "distance_m" DOUBLE PRECISION NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'GEO',
    "status" "DuplicateCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_decisions" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "canonical_id" UUID NOT NULL,
    "decision" "DuplicateDecisionKind" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duplicate_candidates_candidate_id_idx" ON "duplicate_candidates"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidates_report_id_candidate_id_key" ON "duplicate_candidates"("report_id", "candidate_id");

-- CreateIndex
CREATE INDEX "duplicate_decisions_report_id_created_at_idx" ON "duplicate_decisions"("report_id", "created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_decisions" ADD CONSTRAINT "duplicate_decisions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_decisions" ADD CONSTRAINT "duplicate_decisions_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_decisions" ADD CONSTRAINT "duplicate_decisions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written rules ─────────────────────────────────────────────────────────

-- A DUPLICATE report always points to its original, and only DUPLICATE reports do.
ALTER TABLE "reports" ADD CONSTRAINT "reports_duplicate_link_check" CHECK (
  ("status" = 'DUPLICATE') = ("duplicate_of_id" IS NOT NULL));
ALTER TABLE "reports" ADD CONSTRAINT "reports_duplicate_not_self_check" CHECK (
  "duplicate_of_id" IS DISTINCT FROM "id");
CREATE INDEX "reports_duplicate_of_id_idx" ON "reports" ("duplicate_of_id");

ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_pair_check" CHECK (
  "report_id" <> "candidate_id" AND "distance_m" >= 0);
ALTER TABLE "duplicate_decisions" ADD CONSTRAINT "duplicate_decisions_pair_check" CHECK (
  "report_id" <> "canonical_id");
ALTER TABLE "report_categories" ADD CONSTRAINT "report_categories_duplicate_radius_check" CHECK (
  "duplicate_radius_m" IS NULL OR "duplicate_radius_m" BETWEEN 10 AND 1000);

-- Decisions are an audit trail: no UPDATE, DELETE or TRUNCATE.
CREATE TRIGGER "duplicate_decisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "duplicate_decisions"
  FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "duplicate_decisions_no_truncate"
  BEFORE TRUNCATE ON "duplicate_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();

-- Starting radii (metres) by category; children without their own value use the parent's,
-- then 50 m. To be checked against real data before launch (PRD §10.5).
UPDATE "report_categories" SET "duplicate_radius_m" = 30 WHERE "slug" IN ('pothole', 'broken-streetlight');
UPDATE "report_categories" SET "duplicate_radius_m" = 50 WHERE "slug" IN ('road-damage', 'garbage-accumulation');
UPDATE "report_categories" SET "duplicate_radius_m" = 150 WHERE "slug" IN ('drainage-problem', 'waterlogging');
