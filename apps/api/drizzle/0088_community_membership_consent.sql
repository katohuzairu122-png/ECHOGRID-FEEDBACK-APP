CREATE TABLE "community_terms_current" (
	"purpose" text PRIMARY KEY NOT NULL,
	"publication_id" uuid,
	CONSTRAINT "community_terms_current_purpose_check" CHECK ("community_terms_current"."purpose" = 'community_membership')
);
--> statement-breakpoint
CREATE TABLE "community_terms_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"publication" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_terms_publications_version_unique" UNIQUE("version"),
	CONSTRAINT "community_terms_identity_check" CHECK ("community_terms_publications"."publication"->>'id' = "community_terms_publications"."id"::text AND "community_terms_publications"."publication"->>'version' = "community_terms_publications"."version" AND "community_terms_publications"."publication"->>'purpose' = 'community_membership')
);
--> statement-breakpoint
ALTER TABLE "community_memberships" DROP CONSTRAINT "community_memberships_status_check";--> statement-breakpoint
ALTER TABLE "consent_grants" DROP CONSTRAINT "consent_grants_purpose_check";--> statement-breakpoint
ALTER TABLE "community_terms_current" ADD CONSTRAINT "community_terms_current_publication_id_community_terms_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."community_terms_publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_status_check" CHECK ("community_memberships"."status" IN ('active','left','suspended','inactive'));--> statement-breakpoint
ALTER TABLE "consent_grants" ADD CONSTRAINT "consent_grants_purpose_check" CHECK ("consent_grants"."purpose" IN ('join_loyalty','marketing','survey_participation','settlement_access','contact_sharing','community_membership'));
--> statement-breakpoint
-- No approval or effective date is shipped. The singleton starts empty.
INSERT INTO public.community_terms_current(purpose, publication_id) VALUES ('community_membership', NULL);
--> statement-breakpoint
REVOKE ALL ON public.community_terms_publications, public.community_terms_current FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.community_terms_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'COMMUNITY_TERMS_IMMUTABLE' USING ERRCODE='23000'; END IF;
  IF OLD.publication->>'publishedAt' IS NOT NULL OR OLD.publication->'approval'->>'status' IN ('approved','superseded') THEN
    RAISE EXCEPTION 'COMMUNITY_TERMS_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'COMMUNITY_TERMS_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER community_terms_publication_guard BEFORE UPDATE OR DELETE ON public.community_terms_publications FOR EACH ROW EXECUTE FUNCTION public.community_terms_publication_guard();
--> statement-breakpoint
CREATE TRIGGER community_terms_publication_no_truncate BEFORE TRUNCATE ON public.community_terms_publications FOR EACH STATEMENT EXECUTE FUNCTION public.community_terms_publication_guard();
--> statement-breakpoint
ALTER TABLE public.community_terms_publications ENABLE ALWAYS TRIGGER community_terms_publication_guard;
--> statement-breakpoint
ALTER TABLE public.community_terms_publications ENABLE ALWAYS TRIGGER community_terms_publication_no_truncate;
--> statement-breakpoint
CREATE FUNCTION public.community_terms_pointer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE p jsonb;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'COMMUNITY_TERMS_POINTER_REQUIRED' USING ERRCODE='23000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('community_membership_terms_current',0));
  IF NEW.publication_id IS NOT NULL THEN
    SELECT publication INTO p FROM public.community_terms_publications WHERE id=NEW.publication_id;
    IF p IS NULL OR p->'approval'->>'status' IS DISTINCT FROM 'approved' OR p->'approval'->>'reference' IS NULL OR
       p->'approval'->>'approvedAt' IS NULL OR p->>'publishedAt' IS NULL OR p->>'effectiveAt' IS NULL OR
       (p->'approval'->>'approvedAt')::timestamptz > clock_timestamp() OR
       (p->>'publishedAt')::timestamptz > clock_timestamp() OR (p->>'effectiveAt')::timestamptz > clock_timestamp() THEN
      RAISE EXCEPTION 'COMMUNITY_TERMS_NOT_EFFECTIVE' USING ERRCODE='23000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER community_terms_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.community_terms_current FOR EACH ROW EXECUTE FUNCTION public.community_terms_pointer_guard();
--> statement-breakpoint
CREATE TRIGGER community_terms_pointer_no_truncate BEFORE TRUNCATE ON public.community_terms_current FOR EACH STATEMENT EXECUTE FUNCTION public.community_terms_pointer_guard();
--> statement-breakpoint
ALTER TABLE public.community_terms_current ENABLE ALWAYS TRIGGER community_terms_pointer_guard;
--> statement-breakpoint
ALTER TABLE public.community_terms_current ENABLE ALWAYS TRIGGER community_terms_pointer_no_truncate;

--> statement-breakpoint
-- Community requests do not occupy the legacy global key namespace.
CREATE UNIQUE INDEX consent_grants_community_request_key ON public.consent_grants (customer_id, (metadata->>'requestKeyDigest')) WHERE purpose='community_membership' AND metadata->>'requestKeyDigest' IS NOT NULL;
