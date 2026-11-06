-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('NOT_A_CIVIC_ISSUE', 'INSUFFICIENT_INFORMATION', 'ALREADY_FIXED', 'INAPPROPRIATE_CONTENT', 'NO_RESPONSE', 'OTHER');

-- AlterEnum
ALTER TYPE "RoutingOutcome" ADD VALUE 'TRANSFERRED';

-- CreateTable
CREATE TABLE "report_review_decisions" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "rejection_reason" "RejectionReason",
    "public_message" VARCHAR(1000),
    "category_from_id" UUID,
    "category_to_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_information_requests" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_information_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_information_responses" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "responded_by_id" UUID NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "media_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_information_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_transfers" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "from_organization_id" UUID NOT NULL,
    "to_organization_id" UUID,
    "actor_id" UUID NOT NULL,
    "from_status" "ReportStatus" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_internal_notes" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_public_updates" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_by_id" UUID,
    "hidden_reason" VARCHAR(1000),

    CONSTRAINT "report_public_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_review_decisions_report_id_created_at_idx" ON "report_review_decisions"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "report_information_requests_report_id_created_at_idx" ON "report_information_requests"("report_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_information_responses_request_id_key" ON "report_information_responses"("request_id");

-- CreateIndex
CREATE INDEX "report_transfers_report_id_created_at_idx" ON "report_transfers"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "report_internal_notes_report_id_organization_id_created_at_idx" ON "report_internal_notes"("report_id", "organization_id", "created_at");

-- CreateIndex
CREATE INDEX "report_public_updates_report_id_created_at_idx" ON "report_public_updates"("report_id", "created_at");

-- AddForeignKey
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_category_from_id_fkey" FOREIGN KEY ("category_from_id") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_category_to_id_fkey" FOREIGN KEY ("category_to_id") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_requests" ADD CONSTRAINT "report_information_requests_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_requests" ADD CONSTRAINT "report_information_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_requests" ADD CONSTRAINT "report_information_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_responses" ADD CONSTRAINT "report_information_responses_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "report_information_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_responses" ADD CONSTRAINT "report_information_responses_responded_by_id_fkey" FOREIGN KEY ("responded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_from_organization_id_fkey" FOREIGN KEY ("from_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_to_organization_id_fkey" FOREIGN KEY ("to_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_internal_notes" ADD CONSTRAINT "report_internal_notes_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_internal_notes" ADD CONSTRAINT "report_internal_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_internal_notes" ADD CONSTRAINT "report_internal_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_hidden_by_id_fkey" FOREIGN KEY ("hidden_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written rules (not expressible in the Prisma schema) ─────────────────

-- A rejection always has a reason and a message for the citizen; an acceptance has no reason.
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_reason_check" CHECK (
  ("decision" = 'REJECTED' AND "rejection_reason" IS NOT NULL AND "public_message" IS NOT NULL)
  OR ("decision" = 'ACCEPTED' AND "rejection_reason" IS NULL));
-- A category correction records both the old and the new category.
ALTER TABLE "report_review_decisions" ADD CONSTRAINT "report_review_decisions_category_check" CHECK (
  ("category_from_id" IS NULL) = ("category_to_id" IS NULL));
ALTER TABLE "report_information_requests" ADD CONSTRAINT "report_information_requests_message_check" CHECK (length(btrim("message")) > 0);
ALTER TABLE "report_information_responses" ADD CONSTRAINT "report_information_responses_message_check" CHECK (length(btrim("message")) > 0);
ALTER TABLE "report_information_responses" ADD CONSTRAINT "report_information_responses_media_check" CHECK (cardinality("media_ids") <= 5);
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "report_transfers" ADD CONSTRAINT "report_transfers_distinct_check" CHECK ("to_organization_id" IS DISTINCT FROM "from_organization_id");
ALTER TABLE "report_internal_notes" ADD CONSTRAINT "report_internal_notes_body_check" CHECK (length(btrim("body")) > 0);
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_body_check" CHECK (length(btrim("body")) > 0);
-- Hidden updates record who hid them, when and why — all three or none.
ALTER TABLE "report_public_updates" ADD CONSTRAINT "report_public_updates_hidden_check" CHECK (
  ("hidden_at" IS NULL AND "hidden_by_id" IS NULL AND "hidden_reason" IS NULL)
  OR ("hidden_at" IS NOT NULL AND "hidden_by_id" IS NOT NULL AND length(btrim("hidden_reason")) > 0));

-- Append-only records: no UPDATE, DELETE or TRUNCATE.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_review_decisions', 'report_information_requests',
    'report_information_responses', 'report_transfers', 'report_internal_notes']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"()', t || '_no_update_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Public updates: the only allowed change is hiding a visible update, once.
CREATE FUNCTION "report_public_updates_only_hide"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR OLD."hidden_at" IS NOT NULL
     OR NEW."hidden_at" IS NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."report_id" IS DISTINCT FROM OLD."report_id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'report_public_updates: only hiding a visible update is allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "report_public_updates_only_hide"
  BEFORE UPDATE OR DELETE ON "report_public_updates"
  FOR EACH ROW EXECUTE FUNCTION "report_public_updates_only_hide"();
CREATE TRIGGER "report_public_updates_no_truncate"
  BEFORE TRUNCATE ON "report_public_updates"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
