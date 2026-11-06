-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('REPORT_UNDER_REVIEW', 'INFORMATION_REQUESTED', 'REPORT_ACCEPTED', 'REPORT_REJECTED', 'REPORT_TRANSFERRED', 'REPORT_ASSIGNED', 'WORK_STARTED', 'REPORT_RESOLVED', 'REPORT_REOPENED', 'REPORT_CLOSED', 'PUBLIC_UPDATE_POSTED', 'NEW_REPORT', 'INFORMATION_PROVIDED', 'REPORT_WITHDRAWN', 'TASK_DECLINED', 'TASK_RETURNED', 'WORK_SUBMITTED', 'NOT_FIXED_FEEDBACK', 'ACCEPTANCE_OVERDUE', 'TASK_ASSIGNED', 'TASK_CANCELLED', 'MORE_EVIDENCE_NEEDED', 'WORK_APPROVED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'FAILED');

-- AlterTable
ALTER TABLE "report_assignments" ADD COLUMN     "reminder_sent_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "report_public_id" VARCHAR(16),
    "organization_id" UUID,
    "assignment_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "email_my_reports" BOOLEAN NOT NULL DEFAULT true,
    "email_my_tasks" BOOLEAN NOT NULL DEFAULT true,
    "email_organization" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'EMAIL',
    "status" "DeliveryStatus" NOT NULL,
    "error" VARCHAR(500),
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_read_at_created_at_idx" ON "notifications"("recipient_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_event_id_recipient_id_type_key" ON "notifications"("event_id", "recipient_id", "type");

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_id_attempted_at_idx" ON "notification_deliveries"("notification_id", "attempted_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_attempted_at_idx" ON "notification_deliveries"("status", "attempted_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written rules ─────────────────────────────────────────────────────────

-- Delivery attempts are an audit trail: no UPDATE, DELETE or TRUNCATE.
CREATE TRIGGER "notification_deliveries_no_update_delete"
  BEFORE UPDATE OR DELETE ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "notification_deliveries_no_truncate"
  BEFORE TRUNCATE ON "notification_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();

-- Notifications only ever change from unread to read.
CREATE FUNCTION "notifications_only_mark_read"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."recipient_id" IS DISTINCT FROM OLD."recipient_id"
     OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."report_public_id" IS DISTINCT FROM OLD."report_public_id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."assignment_id" IS DISTINCT FROM OLD."assignment_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."read_at" IS NOT NULL AND NEW."read_at" IS DISTINCT FROM OLD."read_at") THEN
    RAISE EXCEPTION 'notifications: only marking as read is allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "notifications_only_mark_read"
  BEFORE UPDATE OR DELETE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "notifications_only_mark_read"();

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempts_check" CHECK ("attempts" >= 0);
