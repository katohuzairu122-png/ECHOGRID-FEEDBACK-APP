CREATE TABLE "surveys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_type" text NOT NULL,
  "business_id" uuid,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "surveys_owner_type_check" CHECK ("owner_type" IN ('platform','business')),
  CONSTRAINT "surveys_owner_business_check" CHECK (("owner_type" = 'platform' AND "business_id" IS NULL) OR ("owner_type" = 'business' AND "business_id" IS NOT NULL)),
  CONSTRAINT "surveys_status_check" CHECK ("status" IN ('draft','published','paused','closed','archived'))
);
--> statement-breakpoint
CREATE TABLE "survey_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "survey_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "survey_versions_status_check" CHECK ("status" IN ('draft','published','archived')),
  CONSTRAINT "survey_versions_published_at_check" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "survey_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version_id" uuid NOT NULL,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "type" text NOT NULL,
  "required" boolean DEFAULT false NOT NULL,
  "position" integer NOT NULL,
  "options" jsonb,
  "validation" jsonb,
  CONSTRAINT "survey_questions_type_check" CHECK ("type" IN ('text','textarea','rating','single_choice','multi_choice','boolean','number')),
  CONSTRAINT "survey_questions_position_check" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "survey_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "survey_id" uuid NOT NULL,
  "survey_version_id" uuid NOT NULL,
  "business_id" uuid,
  "branch_id" uuid,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "audience_class" text NOT NULL,
  "repeat_policy" text DEFAULT 'once_per_campaign' NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "max_responses" integer,
  "expose_in_qr_resolver" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "survey_campaigns_status_check" CHECK ("status" IN ('draft','active','paused','closed')),
  CONSTRAINT "survey_campaigns_audience_class_check" CHECK ("audience_class" IN ('customer','community_candidate','community_member','business_member','general_authenticated_participant')),
  CONSTRAINT "survey_campaigns_repeat_policy_check" CHECK ("repeat_policy" IN ('once','once_per_campaign','repeatable')),
  CONSTRAINT "survey_campaigns_branch_business_check" CHECK ("branch_id" IS NULL OR "business_id" IS NOT NULL),
  CONSTRAINT "survey_campaigns_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "survey_campaigns_max_responses_check" CHECK ("max_responses" IS NULL OR "max_responses" > 0)
);
--> statement-breakpoint
CREATE TABLE "survey_participations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "survey_id" uuid NOT NULL,
  "survey_version_id" uuid NOT NULL,
  "campaign_id" uuid NOT NULL,
  "participant_customer_id" uuid NOT NULL,
  "business_id" uuid,
  "branch_id" uuid,
  "consent_grant_id" uuid,
  "status" text DEFAULT 'started' NOT NULL,
  "idempotency_key" text NOT NULL,
  "submission_payload_hash" text,
  "source" text DEFAULT 'direct' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "invalidated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "survey_participations_status_check" CHECK ("status" IN ('started','submitted','completed','invalidated')),
  CONSTRAINT "survey_participations_source_check" CHECK ("source" IN ('direct','business_qr','customer_qr','link','staff_assisted','other')),
  CONSTRAINT "survey_participations_branch_business_check" CHECK ("branch_id" IS NULL OR "business_id" IS NOT NULL),
  CONSTRAINT "survey_participations_completion_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL),
  CONSTRAINT "survey_participations_invalidation_check" CHECK ("status" <> 'invalidated' OR "invalidated_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "survey_answers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "participation_id" uuid NOT NULL,
  "question_id" uuid NOT NULL,
  "question_key" text NOT NULL,
  "question_label" text NOT NULL,
  "question_type" text NOT NULL,
  "value" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "survey_answers_question_type_check" CHECK ("question_type" IN ('text','textarea','rating','single_choice','multi_choice','boolean','number'))
);
--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_campaigns" ADD CONSTRAINT "survey_campaigns_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_campaigns" ADD CONSTRAINT "survey_campaigns_survey_version_id_survey_versions_id_fk" FOREIGN KEY ("survey_version_id") REFERENCES "public"."survey_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_campaigns" ADD CONSTRAINT "survey_campaigns_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_campaigns" ADD CONSTRAINT "survey_campaigns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_survey_version_id_survey_versions_id_fk" FOREIGN KEY ("survey_version_id") REFERENCES "public"."survey_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_campaign_id_survey_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."survey_campaigns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_participant_customer_id_customers_id_fk" FOREIGN KEY ("participant_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_consent_grant_id_consent_grants_id_fk" FOREIGN KEY ("consent_grant_id") REFERENCES "public"."consent_grants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_participation_id_survey_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."survey_participations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_question_id_survey_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."survey_questions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "surveys_business_status_idx" ON "surveys" USING btree ("business_id","status");
--> statement-breakpoint
CREATE INDEX "surveys_owner_status_idx" ON "surveys" USING btree ("owner_type","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "survey_versions_survey_version_key" ON "survey_versions" USING btree ("survey_id","version");
--> statement-breakpoint
CREATE INDEX "survey_versions_survey_status_idx" ON "survey_versions" USING btree ("survey_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "survey_questions_version_key_key" ON "survey_questions" USING btree ("version_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "survey_questions_version_position_key" ON "survey_questions" USING btree ("version_id","position");
--> statement-breakpoint
CREATE INDEX "survey_campaigns_survey_status_idx" ON "survey_campaigns" USING btree ("survey_id","status");
--> statement-breakpoint
CREATE INDEX "survey_campaigns_business_status_idx" ON "survey_campaigns" USING btree ("business_id","status");
--> statement-breakpoint
CREATE INDEX "survey_campaigns_branch_status_idx" ON "survey_campaigns" USING btree ("branch_id","status");
--> statement-breakpoint
CREATE INDEX "survey_campaigns_window_idx" ON "survey_campaigns" USING btree ("starts_at","ends_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "survey_participations_campaign_idempotency_key" ON "survey_participations" USING btree ("campaign_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "survey_participations_customer_status_idx" ON "survey_participations" USING btree ("participant_customer_id","status");
--> statement-breakpoint
CREATE INDEX "survey_participations_campaign_status_idx" ON "survey_participations" USING btree ("campaign_id","status");
--> statement-breakpoint
CREATE INDEX "survey_participations_business_status_idx" ON "survey_participations" USING btree ("business_id","status");
--> statement-breakpoint
CREATE INDEX "survey_participations_completed_idx" ON "survey_participations" USING btree ("completed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "survey_answers_participation_question_key" ON "survey_answers" USING btree ("participation_id","question_id");
--> statement-breakpoint
CREATE INDEX "survey_answers_participation_idx" ON "survey_answers" USING btree ("participation_id");
