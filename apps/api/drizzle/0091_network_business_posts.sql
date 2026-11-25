ALTER TABLE "network_posts" DROP CONSTRAINT "network_posts_class_official_only";--> statement-breakpoint
ALTER TABLE "network_posts" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_business_id_business_public_profiles_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_public_profiles"("business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_posts_business_idx" ON "network_posts" USING btree ("business_id","state","created_at");--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_class_valid" CHECK ("network_posts"."content_class" IN ('official','business'));--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_business_scope" CHECK (("network_posts"."content_class" = 'business') = ("network_posts"."business_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_pin_official_only" CHECK (NOT "network_posts"."pinned" OR "network_posts"."content_class" = 'official');
CREATE OR REPLACE FUNCTION network_post_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE rev network_post_revisions%ROWTYPE; approvals integer; needed integer;
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
     OR NEW.content_class IS DISTINCT FROM OLD.content_class OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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
    -- Official posts need two distinct approvers (NETWORK-00 N-09); a business post needs one platform approver who is not its author.
    needed := CASE WHEN NEW.content_class = 'official' THEN 2 ELSE 1 END;
    SELECT count(DISTINCT approver_user_id) INTO approvals
      FROM network_revision_approvals WHERE revision_id = rev.id AND approver_user_id <> rev.created_by;
    IF approvals < needed THEN
      RAISE EXCEPTION 'publication needs % distinct approver(s) (has %)', needed, approvals USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- A business post may only go live while its business has a PUBLISHED public profile and is active (NETWORK-00 section 4).
    IF NEW.content_class = 'business' AND NOT EXISTS (
      SELECT 1 FROM business_public_profiles p JOIN businesses b ON b.id = p.business_id
       WHERE p.business_id = NEW.business_id AND p.publication_state = 'published' AND b.status = 'active'
    ) THEN
      RAISE EXCEPTION 'a business post needs a published profile and an active business' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
