CREATE TABLE "network_post_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"body" text NOT NULL,
	"link_url" text,
	"content_locale" text NOT NULL,
	"content_digest" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_rev_no_positive" CHECK ("network_post_revisions"."revision_no" >= 1),
	CONSTRAINT "network_rev_body_length" CHECK (char_length("network_post_revisions"."body") BETWEEN 1 AND 2000),
	CONSTRAINT "network_rev_body_plain_text" CHECK ("network_post_revisions"."body" !~ '[<>]' AND "network_post_revisions"."body" !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
	CONSTRAINT "network_rev_link_https" CHECK ("network_post_revisions"."link_url" IS NULL OR ("network_post_revisions"."link_url" ~ '^https://[^[:space:]<>"]+$' AND char_length("network_post_revisions"."link_url") <= 2048)),
	CONSTRAINT "network_rev_locale" CHECK ("network_post_revisions"."content_locale" IN ('en','fr','es','ar')),
	CONSTRAINT "network_rev_digest_format" CHECK ("network_post_revisions"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "network_rev_status_valid" CHECK ("network_post_revisions"."status" IN ('draft','submitted','approved','rejected','superseded')),
	CONSTRAINT "network_rev_submitted_evidence" CHECK (("network_post_revisions"."status" = 'draft') = ("network_post_revisions"."submitted_at" IS NULL)),
	CONSTRAINT "network_rev_decision_evidence" CHECK ("network_post_revisions"."status" NOT IN ('approved','rejected') OR ("network_post_revisions"."decided_at" IS NOT NULL AND "network_post_revisions"."decided_by" IS NOT NULL)),
	CONSTRAINT "network_rev_rejection_reason" CHECK (("network_post_revisions"."status" = 'rejected') = ("network_post_revisions"."reason_code" IS NOT NULL)),
	CONSTRAINT "network_rev_reason_valid" CHECK ("network_post_revisions"."reason_code" IS NULL OR "network_post_revisions"."reason_code" IN ('hate_or_harassment','threats','sexual_content','illegal_goods_services','fraud_or_scam','impersonation','personal_data','misleading_claim','competitor_disparagement','unsafe_link','spam_or_duplicate')),
	CONSTRAINT "network_rev_decider_not_author" CHECK ("network_post_revisions"."decided_by" IS NULL OR "network_post_revisions"."decided_by" <> "network_post_revisions"."created_by")
);
--> statement-breakpoint
CREATE TABLE "network_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"content_class" text DEFAULT 'official' NOT NULL,
	"author_user_id" uuid NOT NULL,
	"state" text DEFAULT 'unpublished' NOT NULL,
	"live_revision_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_posts_handle_format" CHECK ("network_posts"."handle" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "network_posts_class_official_only" CHECK ("network_posts"."content_class" = 'official'),
	CONSTRAINT "network_posts_state_valid" CHECK ("network_posts"."state" IN ('unpublished','published','suspended','withdrawn')),
	CONSTRAINT "network_posts_pin_requires_published" CHECK (NOT "network_posts"."pinned" OR "network_posts"."state" = 'published'),
	CONSTRAINT "network_posts_published_has_evidence" CHECK ("network_posts"."state" NOT IN ('published','suspended') OR ("network_posts"."live_revision_id" IS NOT NULL AND "network_posts"."published_at" IS NOT NULL AND "network_posts"."expires_at" IS NOT NULL)),
	CONSTRAINT "network_posts_expiry_after_publish" CHECK ("network_posts"."expires_at" IS NULL OR "network_posts"."published_at" IS NULL OR "network_posts"."expires_at" > "network_posts"."published_at")
);
--> statement-breakpoint
CREATE TABLE "network_revision_approvals" (
	"revision_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_revision_approvals_revision_id_approver_user_id_pk" PRIMARY KEY("revision_id","approver_user_id")
);
--> statement-breakpoint
ALTER TABLE "network_post_revisions" ADD CONSTRAINT "network_post_revisions_post_id_network_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."network_posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_post_revisions" ADD CONSTRAINT "network_post_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_post_revisions" ADD CONSTRAINT "network_post_revisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_live_revision_id_network_post_revisions_id_fk" FOREIGN KEY ("live_revision_id") REFERENCES "public"."network_post_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_revision_approvals" ADD CONSTRAINT "network_revision_approvals_revision_id_network_post_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."network_post_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_revision_approvals" ADD CONSTRAINT "network_revision_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_post_revisions_no_uq" ON "network_post_revisions" USING btree ("post_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "network_post_revisions_one_draft_uq" ON "network_post_revisions" USING btree ("post_id") WHERE "network_post_revisions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "network_post_revisions_one_submitted_uq" ON "network_post_revisions" USING btree ("post_id") WHERE "network_post_revisions"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "network_post_revisions_queue_idx" ON "network_post_revisions" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "network_posts_handle_uq" ON "network_posts" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "network_posts_one_pinned_uq" ON "network_posts" USING btree ("content_class") WHERE "network_posts"."pinned" AND "network_posts"."state" = 'published';--> statement-breakpoint
CREATE INDEX "network_posts_feed_idx" ON "network_posts" USING btree ("state","pinned","published_at","id");--> statement-breakpoint
-- NETWORK-01: the rules below fire for EVERY database role, including a direct SQL session, so the application is
-- not the only thing standing between a draft and the feed.
CREATE OR REPLACE FUNCTION network_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'network revisions are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'a draft revision can only be submitted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
       OR NEW.body IS DISTINCT FROM OLD.body OR NEW.link_url IS DISTINCT FROM OLD.link_url
       OR NEW.content_locale IS DISTINCT FROM OLD.content_locale OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a submitted network revision is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT ((OLD.status = 'submitted' AND NEW.status IN ('submitted', 'approved', 'rejected'))
         OR (OLD.status = 'approved' AND NEW.status IN ('approved', 'superseded'))
         OR (OLD.status = NEW.status)) THEN
      RAISE EXCEPTION 'illegal network revision transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('rejected', 'superseded') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'a % network revision is final', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_revision_guard_trg BEFORE UPDATE OR DELETE ON network_post_revisions
  FOR EACH ROW EXECUTE FUNCTION network_revision_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION network_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE rev network_post_revisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'network approvals are append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO rev FROM network_post_revisions WHERE id = NEW.revision_id;
  IF rev.id IS NULL OR rev.status <> 'submitted' THEN
    RAISE EXCEPTION 'only a submitted revision can be approved' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.approver_user_id = rev.created_by THEN
    RAISE EXCEPTION 'an author cannot approve their own revision' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_approval_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON network_revision_approvals
  FOR EACH ROW EXECUTE FUNCTION network_approval_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION network_post_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE rev network_post_revisions%ROWTYPE; approvals integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'network posts are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'unpublished' OR NEW.live_revision_id IS NOT NULL OR NEW.pinned THEN
      RAISE EXCEPTION 'a network post starts unpublished' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.handle IS DISTINCT FROM OLD.handle OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.content_class IS DISTINCT FROM OLD.content_class OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'network post identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'withdrawn' AND NEW.state <> 'withdrawn' THEN
    RAISE EXCEPTION 'a withdrawn post stays withdrawn' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'published'
     AND (OLD.state <> 'published' OR OLD.live_revision_id IS DISTINCT FROM NEW.live_revision_id) THEN
    SELECT * INTO rev FROM network_post_revisions WHERE id = NEW.live_revision_id;
    IF rev.id IS NULL OR rev.post_id <> NEW.id OR rev.status <> 'approved' THEN
      RAISE EXCEPTION 'only an approved revision of this post can go live' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT count(DISTINCT approver_user_id) INTO approvals
      FROM network_revision_approvals WHERE revision_id = rev.id AND approver_user_id <> rev.created_by;
    IF approvals < 2 THEN
      RAISE EXCEPTION 'publication needs two distinct approvers (has %)', approvals USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_post_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON network_posts
  FOR EACH ROW EXECUTE FUNCTION network_post_guard();
--> statement-breakpoint
-- TRUNCATE bypasses row triggers, so every guarded table also denies it (the repository-wide structural guard in
-- financial-truncate-denial requires this), and every guard is ENABLE ALWAYS so a session_replication_role = replica
-- session cannot skip it either.
CREATE OR REPLACE FUNCTION network_truncate_denied() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'NETWORK_TRUNCATE_DENIED (%)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_posts_no_truncate BEFORE TRUNCATE ON network_posts FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER network_post_revisions_no_truncate BEFORE TRUNCATE ON network_post_revisions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER network_revision_approvals_no_truncate BEFORE TRUNCATE ON network_revision_approvals FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE network_posts ENABLE ALWAYS TRIGGER network_post_guard_trg;
--> statement-breakpoint
ALTER TABLE network_posts ENABLE ALWAYS TRIGGER network_posts_no_truncate;
--> statement-breakpoint
ALTER TABLE network_post_revisions ENABLE ALWAYS TRIGGER network_revision_guard_trg;
--> statement-breakpoint
ALTER TABLE network_post_revisions ENABLE ALWAYS TRIGGER network_post_revisions_no_truncate;
--> statement-breakpoint
ALTER TABLE network_revision_approvals ENABLE ALWAYS TRIGGER network_approval_guard_trg;
--> statement-breakpoint
ALTER TABLE network_revision_approvals ENABLE ALWAYS TRIGGER network_revision_approvals_no_truncate;
