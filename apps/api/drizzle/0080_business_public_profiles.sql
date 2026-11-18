CREATE TABLE "business_category_translations" (
	"category_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "business_category_translations_category_id_locale_pk" PRIMARY KEY("category_id","locale"),
	CONSTRAINT "business_category_translations_locale" CHECK ("business_category_translations"."locale" IN ('en','es','fr','ar')),
	CONSTRAINT "business_category_translations_name_length" CHECK (char_length("business_category_translations"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "business_profile_revision_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"country_code" text,
	"city" text,
	"region" text,
	"street_address" text,
	CONSTRAINT "business_profile_revision_locations_position_nonneg" CHECK ("business_profile_revision_locations"."position" >= 0),
	CONSTRAINT "business_profile_revision_locations_kind" CHECK ("business_profile_revision_locations"."kind" IN ('place','service_area')),
	CONSTRAINT "business_profile_revision_locations_label_length" CHECK (char_length("business_profile_revision_locations"."label") BETWEEN 1 AND 120),
	CONSTRAINT "business_profile_revision_locations_country_format" CHECK ("business_profile_revision_locations"."country_code" IS NULL OR "business_profile_revision_locations"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "business_profile_revision_locations_city_length" CHECK ("business_profile_revision_locations"."city" IS NULL OR char_length("business_profile_revision_locations"."city") BETWEEN 1 AND 80),
	CONSTRAINT "business_profile_revision_locations_region_length" CHECK ("business_profile_revision_locations"."region" IS NULL OR char_length("business_profile_revision_locations"."region") BETWEEN 1 AND 80),
	CONSTRAINT "business_profile_revision_locations_street_length" CHECK ("business_profile_revision_locations"."street_address" IS NULL OR char_length("business_profile_revision_locations"."street_address") BETWEEN 1 AND 160),
	CONSTRAINT "business_profile_revision_locations_place_fields" CHECK ("business_profile_revision_locations"."kind" <> 'place' OR ("business_profile_revision_locations"."city" IS NOT NULL AND "business_profile_revision_locations"."country_code" IS NOT NULL)),
	CONSTRAINT "business_profile_revision_locations_area_no_street" CHECK ("business_profile_revision_locations"."kind" <> 'service_area' OR "business_profile_revision_locations"."street_address" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "business_profile_revision_translations" (
	"revision_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"display_name" text NOT NULL,
	"summary" text,
	"description" text,
	CONSTRAINT "business_profile_revision_translations_revision_id_locale_pk" PRIMARY KEY("revision_id","locale"),
	CONSTRAINT "business_profile_revision_translations_locale" CHECK ("business_profile_revision_translations"."locale" IN ('en','es','fr','ar')),
	CONSTRAINT "business_profile_revision_translations_name_length" CHECK (char_length(btrim("business_profile_revision_translations"."display_name")) BETWEEN 2 AND 80),
	CONSTRAINT "business_profile_revision_translations_summary_length" CHECK ("business_profile_revision_translations"."summary" IS NULL OR char_length("business_profile_revision_translations"."summary") BETWEEN 1 AND 160),
	CONSTRAINT "business_profile_revision_translations_description_length" CHECK ("business_profile_revision_translations"."description" IS NULL OR char_length("business_profile_revision_translations"."description") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "business_profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"website_url" text,
	"content_digest" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason_code" text,
	"review_note_internal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "business_profile_revisions_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "business_profile_revisions_no_positive" CHECK ("business_profile_revisions"."revision_no" >= 1),
	CONSTRAINT "business_profile_revisions_status_valid" CHECK ("business_profile_revisions"."status" IN ('draft','submitted','approved','rejected','superseded')),
	CONSTRAINT "business_profile_revisions_website_https" CHECK ("business_profile_revisions"."website_url" IS NULL OR ("business_profile_revisions"."website_url" ~ '^https://[^[:space:]<>"]+$' AND char_length("business_profile_revisions"."website_url") <= 2048)),
	CONSTRAINT "business_profile_revisions_digest_format" CHECK ("business_profile_revisions"."content_digest" IS NULL OR "business_profile_revisions"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "business_profile_revisions_digest_required" CHECK ("business_profile_revisions"."status" = 'draft' OR "business_profile_revisions"."content_digest" IS NOT NULL),
	CONSTRAINT "business_profile_revisions_submission_evidence" CHECK (("business_profile_revisions"."status" = 'draft') = ("business_profile_revisions"."submitted_at" IS NULL) AND ("business_profile_revisions"."status" = 'draft') = ("business_profile_revisions"."submitted_by" IS NULL)),
	CONSTRAINT "business_profile_revisions_review_fields" CHECK (("business_profile_revisions"."status" IN ('approved','rejected','superseded')) = ("business_profile_revisions"."reviewed_by" IS NOT NULL AND "business_profile_revisions"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "business_profile_revisions_reason_scope" CHECK (("business_profile_revisions"."status" = 'rejected') = ("business_profile_revisions"."review_reason_code" IS NOT NULL)),
	CONSTRAINT "business_profile_revisions_reason_format" CHECK ("business_profile_revisions"."review_reason_code" IS NULL OR "business_profile_revisions"."review_reason_code" ~ '^[A-Z_]{3,40}$'),
	CONSTRAINT "business_profile_revisions_note_length" CHECK ("business_profile_revisions"."review_note_internal" IS NULL OR char_length("business_profile_revisions"."review_note_internal") <= 500),
	CONSTRAINT "business_profile_revisions_separation_of_duties" CHECK ("business_profile_revisions"."reviewed_by" IS NULL OR "business_profile_revisions"."submitted_by" IS NULL OR "business_profile_revisions"."reviewed_by" <> "business_profile_revisions"."submitted_by")
);
--> statement-breakpoint
CREATE TABLE "business_public_profiles" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"profile_handle" text NOT NULL,
	"publication_state" text DEFAULT 'unpublished' NOT NULL,
	"published_revision_id" uuid,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspended_by" uuid,
	"suspension_reason_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "business_public_profiles_handle_format" CHECK ("business_public_profiles"."profile_handle" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "business_public_profiles_state_valid" CHECK ("business_public_profiles"."publication_state" IN ('unpublished','published','suspended','withdrawn')),
	CONSTRAINT "business_public_profiles_version_positive" CHECK ("business_public_profiles"."version" >= 1),
	CONSTRAINT "business_public_profiles_published_needs_pointer" CHECK ("business_public_profiles"."publication_state" <> 'published' OR "business_public_profiles"."published_revision_id" IS NOT NULL),
	CONSTRAINT "business_public_profiles_published_needs_evidence" CHECK ("business_public_profiles"."publication_state" <> 'published' OR "business_public_profiles"."published_at" IS NOT NULL),
	CONSTRAINT "business_public_profiles_suspended_fields" CHECK (("business_public_profiles"."publication_state" = 'suspended') = ("business_public_profiles"."suspended_at" IS NOT NULL AND "business_public_profiles"."suspension_reason_code" IS NOT NULL)),
	CONSTRAINT "business_public_profiles_suspension_cleared" CHECK ("business_public_profiles"."publication_state" = 'suspended' OR ("business_public_profiles"."suspended_at" IS NULL AND "business_public_profiles"."suspended_by" IS NULL AND "business_public_profiles"."suspension_reason_code" IS NULL)),
	CONSTRAINT "business_public_profiles_suspension_reason_format" CHECK ("business_public_profiles"."suspension_reason_code" IS NULL OR "business_public_profiles"."suspension_reason_code" ~ '^[A-Z_]{3,40}$')
);
--> statement-breakpoint
ALTER TABLE "business_category_translations" ADD CONSTRAINT "business_category_translations_category_id_business_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."business_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profile_revision_locations" ADD CONSTRAINT "business_profile_revision_locations_revision_business_fk" FOREIGN KEY ("revision_id","business_id") REFERENCES "public"."business_profile_revisions"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profile_revision_translations" ADD CONSTRAINT "business_profile_revision_translations_revision_business_fk" FOREIGN KEY ("revision_id","business_id") REFERENCES "public"."business_profile_revisions"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profile_revisions" ADD CONSTRAINT "business_profile_revisions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_public_profiles" ADD CONSTRAINT "business_public_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_public_profiles" ADD CONSTRAINT "business_public_profiles_pointer_business_fk" FOREIGN KEY ("business_id","published_revision_id") REFERENCES "public"."business_profile_revisions"("business_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_revision_locations_position_uq" ON "business_profile_revision_locations" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX "business_profile_revision_translations_name_idx" ON "business_profile_revision_translations" USING btree ("locale",lower("display_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_revisions_no_uq" ON "business_profile_revisions" USING btree ("business_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_revisions_one_draft_uq" ON "business_profile_revisions" USING btree ("business_id") WHERE "business_profile_revisions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_revisions_one_submitted_uq" ON "business_profile_revisions" USING btree ("business_id") WHERE "business_profile_revisions"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "business_profile_revisions_business_status_idx" ON "business_profile_revisions" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "business_profile_revisions_queue_idx" ON "business_profile_revisions" USING btree ("status","submitted_at") WHERE "business_profile_revisions"."status" = 'submitted';--> statement-breakpoint
CREATE UNIQUE INDEX "business_public_profiles_handle_uq" ON "business_public_profiles" USING btree ("profile_handle");--> statement-breakpoint
CREATE INDEX "business_public_profiles_published_idx" ON "business_public_profiles" USING btree ("business_id") WHERE "business_public_profiles"."publication_state" = 'published';
--> statement-breakpoint
-- BDPN-F1 guards (BDPN-01A 4.1 and 4.2). The rules below fire for EVERY database role, including a direct SQL session,
-- so the application is not the only thing standing between a draft and a published profile. Who may ask for a
-- transition stays application authorization (BDPN-01B); WHICH transitions are legal is enforced here.
CREATE OR REPLACE FUNCTION business_profile_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE def_locale text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'business profile revisions are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a business profile revision starts as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'business profile revision identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'a draft revision can only be submitted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'submitted' THEN
      -- D-04: display name, summary and description in the business default locale, and at least one location.
      SELECT default_locale INTO def_locale FROM businesses WHERE id = NEW.business_id;
      IF NOT EXISTS (
        SELECT 1 FROM business_profile_revision_translations t
         WHERE t.revision_id = OLD.id AND t.locale = def_locale
           AND t.summary IS NOT NULL AND t.description IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'submission needs a default-locale display name, summary and description'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM business_profile_revision_locations l WHERE l.revision_id = OLD.id) THEN
        RAISE EXCEPTION 'submission needs at least one location or service area'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  ELSE
    IF NEW.website_url IS DISTINCT FROM OLD.website_url OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'a submitted business profile revision is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT ((OLD.status = 'submitted' AND NEW.status IN ('submitted', 'approved', 'rejected'))
         OR (OLD.status = 'approved' AND NEW.status IN ('approved', 'superseded'))
         OR (OLD.status = NEW.status)) THEN
      RAISE EXCEPTION 'illegal business profile revision transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('approved', 'rejected', 'superseded')
       AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
            OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code) THEN
      RAISE EXCEPTION 'review evidence is immutable once decided' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('rejected', 'superseded') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'a % business profile revision is final', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER business_profile_revision_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON business_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION business_profile_revision_guard();
--> statement-breakpoint
-- Translations and locations are content of a revision: writable only while that revision is a draft.
CREATE OR REPLACE FUNCTION business_profile_child_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE st text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO st FROM business_profile_revisions WHERE id = OLD.revision_id;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'business profile revision content is frozen once submitted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO st FROM business_profile_revisions WHERE id = NEW.revision_id;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'business profile revision content is frozen once submitted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER business_profile_translation_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON business_profile_revision_translations
  FOR EACH ROW EXECUTE FUNCTION business_profile_child_guard();
--> statement-breakpoint
CREATE TRIGGER business_profile_location_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON business_profile_revision_locations
  FOR EACH ROW EXECUTE FUNCTION business_profile_child_guard();
--> statement-breakpoint
-- The publication state machine (BDPN-01A 4.1). Everything not listed raises.
CREATE OR REPLACE FUNCTION business_public_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE rev business_profile_revisions%ROWTYPE; old_rev business_profile_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'business public profiles are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.publication_state <> 'unpublished' OR NEW.published_revision_id IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a business public profile starts unpublished, with no live revision, at version 1'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.profile_handle IS DISTINCT FROM OLD.profile_handle
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'business public profile identity and handle are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.publication_state IS DISTINCT FROM OLD.publication_state THEN
    IF OLD.publication_state IN ('unpublished', 'withdrawn') AND NEW.publication_state = 'published' THEN
      SELECT * INTO rev FROM business_profile_revisions WHERE id = NEW.published_revision_id;
      IF rev.id IS NULL OR rev.business_id <> NEW.business_id OR rev.status <> 'approved' THEN
        RAISE EXCEPTION 'only an approved revision of this business can go live' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF OLD.publication_state = 'published' AND NEW.publication_state = 'withdrawn' THEN
      IF NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id THEN
        RAISE EXCEPTION 'withdrawal keeps the live revision pointer' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF OLD.publication_state IN ('unpublished', 'published', 'withdrawn') AND NEW.publication_state = 'suspended' THEN
      IF NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id THEN
        RAISE EXCEPTION 'suspension keeps the live revision pointer' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF OLD.publication_state = 'suspended' AND NEW.publication_state = 'unpublished' THEN
      IF NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id THEN
        RAISE EXCEPTION 'lifting a suspension keeps the live revision pointer' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'illegal business profile publication transition % -> %', OLD.publication_state, NEW.publication_state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id THEN
    IF NEW.publication_state <> 'published' THEN
      RAISE EXCEPTION 'the live revision only moves while the profile is published' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT * INTO rev FROM business_profile_revisions WHERE id = NEW.published_revision_id;
    SELECT * INTO old_rev FROM business_profile_revisions WHERE id = OLD.published_revision_id;
    IF rev.id IS NULL OR rev.business_id <> NEW.business_id OR rev.status <> 'approved'
       OR old_rev.id IS NULL OR rev.revision_no <= old_rev.revision_no THEN
      RAISE EXCEPTION 'the live revision can only move to a newer approved revision of this business'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF (NEW.publication_state IS DISTINCT FROM OLD.publication_state
      OR NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id)
     AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every publication transition increments the version by one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER business_public_profile_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON business_public_profiles
  FOR EACH ROW EXECUTE FUNCTION business_public_profile_guard();
--> statement-breakpoint
-- TRUNCATE bypasses row triggers, so every guarded table also denies it (the repository-wide structural guard in
-- financial-truncate-denial requires this), and every guard is ENABLE ALWAYS so a session_replication_role = replica
-- session cannot skip it.
CREATE OR REPLACE FUNCTION business_profile_truncate_denied() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'BUSINESS_PROFILE_TRUNCATE_DENIED (%)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER business_public_profiles_no_truncate BEFORE TRUNCATE ON business_public_profiles FOR EACH STATEMENT EXECUTE FUNCTION business_profile_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER business_profile_revisions_no_truncate BEFORE TRUNCATE ON business_profile_revisions FOR EACH STATEMENT EXECUTE FUNCTION business_profile_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER business_profile_revision_translations_no_truncate BEFORE TRUNCATE ON business_profile_revision_translations FOR EACH STATEMENT EXECUTE FUNCTION business_profile_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER business_profile_revision_locations_no_truncate BEFORE TRUNCATE ON business_profile_revision_locations FOR EACH STATEMENT EXECUTE FUNCTION business_profile_truncate_denied();
--> statement-breakpoint
ALTER TABLE business_public_profiles ENABLE ALWAYS TRIGGER business_public_profile_guard_trg;
--> statement-breakpoint
ALTER TABLE business_public_profiles ENABLE ALWAYS TRIGGER business_public_profiles_no_truncate;
--> statement-breakpoint
ALTER TABLE business_profile_revisions ENABLE ALWAYS TRIGGER business_profile_revision_guard_trg;
--> statement-breakpoint
ALTER TABLE business_profile_revisions ENABLE ALWAYS TRIGGER business_profile_revisions_no_truncate;
--> statement-breakpoint
ALTER TABLE business_profile_revision_translations ENABLE ALWAYS TRIGGER business_profile_translation_guard_trg;
--> statement-breakpoint
ALTER TABLE business_profile_revision_translations ENABLE ALWAYS TRIGGER business_profile_revision_translations_no_truncate;
--> statement-breakpoint
ALTER TABLE business_profile_revision_locations ENABLE ALWAYS TRIGGER business_profile_location_guard_trg;
--> statement-breakpoint
ALTER TABLE business_profile_revision_locations ENABLE ALWAYS TRIGGER business_profile_revision_locations_no_truncate;
