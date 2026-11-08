-- CreateEnum
CREATE TYPE "AiPredictionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiReviewAction" AS ENUM ('ACCEPTED', 'CORRECTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ai_predictions" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "task" VARCHAR(40) NOT NULL DEFAULT 'road_damage',
    "status" "AiPredictionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model_version" VARCHAR(60),
    "label" VARCHAR(40),
    "confidence" REAL,
    "uncertain" BOOLEAN,
    "output" JSONB,
    "error_code" VARCHAR(60),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "review_action" "AiReviewAction",
    "corrected_label" VARCHAR(40),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_predictions_report_id_created_at_idx" ON "ai_predictions"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_predictions_media_id_idx" ON "ai_predictions"("media_id");

-- CreateIndex
CREATE INDEX "ai_predictions_status_created_at_idx" ON "ai_predictions"("status", "created_at");

-- AddForeignKey
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "report_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Labels the model and reviewers can use.
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_label_check"
  CHECK ("label" IS NULL OR "label" IN ('pothole', 'crack', 'asphalt_damage', 'no_damage'));
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_corrected_label_check"
  CHECK ("corrected_label" IS NULL OR "corrected_label" IN ('pothole', 'crack', 'asphalt_damage', 'no_damage'));
-- A review records who and when together, and a correction says what the photo shows.
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_review_check"
  CHECK (("review_action" IS NULL) = ("reviewed_at" IS NULL)
     AND ("review_action" IS NULL) = ("reviewed_by_id" IS NULL)
     AND (("review_action" = 'CORRECTED') = ("corrected_label" IS NOT NULL)));
