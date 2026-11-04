-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('CITY_CORPORATION');

-- AlterEnum
ALTER TYPE "OrganizationRole" ADD VALUE 'ORG_REVIEWER';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "description" VARCHAR(2000),
-- No organizations could be created before this migration, so NOT NULL is safe.
ADD COLUMN     "official_email_domain" VARCHAR(253) NOT NULL,
ADD COLUMN     "public_email" VARCHAR(254),
ADD COLUMN     "public_phone" VARCHAR(30),
ADD COLUMN     "type" "OrganizationType" NOT NULL DEFAULT 'CITY_CORPORATION',
ADD COLUMN     "website" VARCHAR(300);

-- Hand-edited: convert in place instead of Prisma's DROP + ADD, which would delete names.
ALTER TABLE "organizations" ALTER COLUMN "name" TYPE CITEXT;

-- CreateTable
CREATE TABLE "organization_verification_contacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "job_title" VARCHAR(100) NOT NULL,
    "email" CITEXT NOT NULL,
    "token_hash" CHAR(64),
    "token_expires_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_verification_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_verification_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "from_state" "OrganizationVerificationState" NOT NULL,
    "to_state" "OrganizationVerificationState" NOT NULL,
    "decided_by_id" UUID NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_verification_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_areas" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "geom" geometry(MultiPolygon,4326) NOT NULL,
    "area_sq_km" DECIMAL(12,3) NOT NULL,
    "point_count" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "parent_id" UUID,
    "name_en" VARCHAR(100) NOT NULL,
    "name_bn" VARCHAR(100) NOT NULL,
    "description_en" VARCHAR(500),
    "description_bn" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "duplicate_radius_m" INTEGER,
    "ai_config" JSONB,
    "evidence_rules" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_categories" (
    "organization_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_categories_pkey" PRIMARY KEY ("organization_id","category_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_verification_contacts_organization_id_key" ON "organization_verification_contacts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_verification_contacts_token_hash_key" ON "organization_verification_contacts"("token_hash");

-- CreateIndex
CREATE INDEX "organization_verification_records_organization_id_created_a_idx" ON "organization_verification_records"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_accepted_at_revoke_idx" ON "organization_invitations"("organization_id", "accepted_at", "revoked_at");

-- CreateIndex
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations"("email");

-- CreateIndex
CREATE INDEX "service_areas_geom_idx" ON "service_areas" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "service_areas_organization_id_is_active_idx" ON "service_areas"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "report_categories_slug_key" ON "report_categories"("slug");

-- CreateIndex
CREATE INDEX "report_categories_parent_id_display_order_idx" ON "report_categories"("parent_id", "display_order");

-- CreateIndex
CREATE INDEX "organization_categories_category_id_idx" ON "organization_categories"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_name_key" ON "organizations"("name");

-- CreateIndex
CREATE INDEX "organizations_verification_state_is_active_idx" ON "organizations"("verification_state", "is_active");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_contacts" ADD CONSTRAINT "organization_verification_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_records" ADD CONSTRAINT "organization_verification_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_records" ADD CONSTRAINT "organization_verification_records_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_categories" ADD CONSTRAINT "report_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_categories" ADD CONSTRAINT "organization_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_categories" ADD CONSTRAINT "organization_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written additions (not generated by Prisma) ───────────────────────────

-- Official domains are stored lower-case without a leading "@".
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_official_email_domain_format"
  CHECK ("official_email_domain" = lower("official_email_domain") AND "official_email_domain" !~ '^@');

-- Service areas must be valid geometry in EPSG:4326; invalid shapes are rejected, never repaired.
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_geom_valid"
  CHECK (ST_IsValid("geom") AND ST_SRID("geom") = 4326);

-- Categories are at most two levels deep: a parent cannot itself have a parent.
CREATE FUNCTION "report_categories_check_depth"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parent_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "report_categories" WHERE "id" = NEW."parent_id" AND "parent_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'report_categories may be at most two levels deep'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parent_id" = NEW."id" THEN
    RAISE EXCEPTION 'a category cannot be its own parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "report_categories_depth"
  BEFORE INSERT OR UPDATE OF "parent_id" ON "report_categories"
  FOR EACH ROW EXECUTE FUNCTION "report_categories_check_depth"();

-- Verification decisions are append-only, like the audit log.
CREATE FUNCTION "append_only_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "organization_verification_records_no_update_delete"
  BEFORE UPDATE OR DELETE ON "organization_verification_records"
  FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();

CREATE TRIGGER "organization_verification_records_no_truncate"
  BEFORE TRUNCATE ON "organization_verification_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();

-- Initial categories from PRD §5.3. Bangla names need review by a native speaker.
INSERT INTO "report_categories" ("id", "slug", "parent_id", "name_en", "name_bn", "display_order", "updated_at") VALUES
  (gen_random_uuid(), 'road-damage', NULL, 'Road damage', 'সড়কের ক্ষতি', 10, now()),
  (gen_random_uuid(), 'drainage-problem', NULL, 'Drainage problem', 'ড্রেনেজ সমস্যা', 20, now()),
  (gen_random_uuid(), 'waterlogging', NULL, 'Waterlogging', 'জলাবদ্ধতা', 30, now()),
  (gen_random_uuid(), 'garbage-accumulation', NULL, 'Garbage accumulation', 'আবর্জনা জমে থাকা', 40, now()),
  (gen_random_uuid(), 'broken-streetlight', NULL, 'Broken streetlight', 'নষ্ট সড়কবাতি', 50, now()),
  (gen_random_uuid(), 'damaged-public-infrastructure', NULL, 'Damaged public infrastructure', 'ক্ষতিগ্রস্ত গণ-অবকাঠামো', 60, now()),
  (gen_random_uuid(), 'other-civic-issue', NULL, 'Other civic issue', 'অন্যান্য নাগরিক সমস্যা', 70, now());

INSERT INTO "report_categories" ("id", "slug", "parent_id", "name_en", "name_bn", "display_order", "updated_at")
SELECT gen_random_uuid(), c.slug, p."id", c.name_en, c.name_bn, c.display_order, now()
FROM (VALUES
  ('pothole', 'Pothole', 'রাস্তার গর্ত', 10),
  ('longitudinal-crack', 'Longitudinal crack', 'লম্বালম্বি ফাটল', 20),
  ('transverse-crack', 'Transverse crack', 'আড়াআড়ি ফাটল', 30),
  ('alligator-cracking', 'Alligator cracking', 'জালের মতো ফাটল', 40),
  ('surface-deterioration', 'Surface deterioration', 'রাস্তার উপরিভাগের ক্ষয়', 50),
  ('road-subsidence', 'Road subsidence', 'রাস্তা দেবে যাওয়া', 60),
  ('damaged-sidewalk', 'Damaged sidewalk', 'ক্ষতিগ্রস্ত ফুটপাত', 70),
  ('other-road-damage', 'Other road damage', 'সড়কের অন্যান্য ক্ষতি', 80)
) AS c(slug, name_en, name_bn, display_order)
CROSS JOIN "report_categories" p
WHERE p."slug" = 'road-damage';
