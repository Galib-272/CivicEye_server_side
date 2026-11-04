-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'ACCEPTED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'WORK_COMPLETED', 'PENDING_VERIFICATION', 'RESOLVED', 'REOPENED', 'CLOSED', 'WITHDRAWN', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ReportVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'ORGANIZATION_ONLY', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "RoutingOutcome" AS ENUM ('ROUTED', 'UNROUTED', 'AMBIGUOUS', 'MANUAL');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('REPORT_PHOTO');

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(16) NOT NULL,
    "citizen_id" UUID NOT NULL,
    "organization_id" UUID,
    "category_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "priority" INTEGER,
    "location" geography(Point,4326) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "location_accuracy_m" INTEGER,
    "location_description" VARCHAR(300),
    "visibility" "ReportVisibility" NOT NULL DEFAULT 'PUBLIC',
    "routing_outcome" "RoutingOutcome" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_status_history" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "from_status" "ReportStatus",
    "to_status" "ReportStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_context" VARCHAR(50) NOT NULL,
    "reason" VARCHAR(1000),
    "public_message" VARCHAR(1000),
    "internal_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_edits" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "editor_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_edits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_media" (
    "id" UUID NOT NULL,
    "report_id" UUID,
    "uploader_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "original_key" VARCHAR(200) NOT NULL,
    "display_key" VARCHAR(200),
    "thumbnail_key" VARCHAR(200),
    "declared_type" VARCHAR(50) NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "detected_format" VARCHAR(20),
    "width" INTEGER,
    "height" INTEGER,
    "sha256" CHAR(64),
    "rejection_reason" VARCHAR(300),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "report_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_routing_decisions" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "outcome" "RoutingOutcome" NOT NULL,
    "organization_id" UUID,
    "candidates" JSONB NOT NULL,
    "rule" VARCHAR(100) NOT NULL,
    "decided_by_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_routing_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "route" VARCHAR(100) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_public_id_key" ON "reports"("public_id");

-- CreateIndex
CREATE INDEX "reports_location_idx" ON "reports" USING GIST ("location");

-- CreateIndex
CREATE INDEX "reports_citizen_id_created_at_idx" ON "reports"("citizen_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_organization_id_status_created_at_idx" ON "reports"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "reports_status_visibility_created_at_idx" ON "reports"("status", "visibility", "created_at");

-- CreateIndex
CREATE INDEX "reports_routing_outcome_status_idx" ON "reports"("routing_outcome", "status");

-- CreateIndex
CREATE INDEX "reports_category_id_idx" ON "reports"("category_id");

-- CreateIndex
CREATE INDEX "report_status_history_report_id_created_at_idx" ON "report_status_history"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "report_edits_report_id_version_idx" ON "report_edits"("report_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "report_media_original_key_key" ON "report_media"("original_key");

-- CreateIndex
CREATE INDEX "report_media_report_id_position_idx" ON "report_media"("report_id", "position");

-- CreateIndex
CREATE INDEX "report_media_uploader_id_status_created_at_idx" ON "report_media"("uploader_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "report_routing_decisions_report_id_created_at_idx" ON "report_routing_decisions"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_route_key_key" ON "idempotency_keys"("user_id", "route", "key");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_status_history" ADD CONSTRAINT "report_status_history_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_status_history" ADD CONSTRAINT "report_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_edits" ADD CONSTRAINT "report_edits_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_edits" ADD CONSTRAINT "report_edits_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_routing_decisions" ADD CONSTRAINT "report_routing_decisions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_routing_decisions" ADD CONSTRAINT "report_routing_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_routing_decisions" ADD CONSTRAINT "report_routing_decisions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written additions (not generated by Prisma) ───────────────────────────

-- Coordinates must be valid WGS84 and agree with the authoritative geography column.
ALTER TABLE "reports" ADD CONSTRAINT "reports_coordinates_valid" CHECK (
  "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180
  AND abs(ST_Y("location"::geometry) - "latitude") < 0.000001
  AND abs(ST_X("location"::geometry) - "longitude") < 0.000001
);
ALTER TABLE "reports" ADD CONSTRAINT "reports_version_positive" CHECK ("version" >= 1);
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_position_range" CHECK ("position" BETWEEN 0 AND 4);
ALTER TABLE "report_media" ADD CONSTRAINT "report_media_declared_bytes_positive" CHECK ("declared_bytes" > 0);

-- Status history and edit history are append-only (PRD §6.4, §5.4).
CREATE TRIGGER "report_status_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "report_status_history"
  FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "report_status_history_no_truncate"
  BEFORE TRUNCATE ON "report_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "report_edits_no_update_delete"
  BEFORE UPDATE OR DELETE ON "report_edits"
  FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "report_edits_no_truncate"
  BEFORE TRUNCATE ON "report_edits"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
