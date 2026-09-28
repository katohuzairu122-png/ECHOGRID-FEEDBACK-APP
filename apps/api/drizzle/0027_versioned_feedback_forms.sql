CREATE TABLE "feedback_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "feedback_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_form_versions_status_check" CHECK ("feedback_form_versions"."status" IN ('published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "feedback_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"options" jsonb,
	CONSTRAINT "feedback_questions_type_check" CHECK ("feedback_questions"."type" IN ('text','textarea','rating','single_choice','multi_choice','boolean'))
);
--> statement-breakpoint
ALTER TABLE "qr_codes" ADD COLUMN "feedback_form_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "form_version_id" uuid;
--> statement-breakpoint
CREATE TABLE "feedback_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_label" text NOT NULL,
	"question_type" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_form_versions" ADD CONSTRAINT "feedback_form_versions_form_id_feedback_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."feedback_forms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_questions" ADD CONSTRAINT "feedback_questions_version_id_feedback_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."feedback_form_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_feedback_form_version_id_feedback_form_versions_id_fk" FOREIGN KEY ("feedback_form_version_id") REFERENCES "public"."feedback_form_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_form_version_id_feedback_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."feedback_form_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_question_id_feedback_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."feedback_questions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_forms_business_idx" ON "feedback_forms" USING btree ("business_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_form_versions_form_version_key" ON "feedback_form_versions" USING btree ("form_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_questions_version_key_key" ON "feedback_questions" USING btree ("version_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_questions_version_position_key" ON "feedback_questions" USING btree ("version_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_answers_feedback_question_key" ON "feedback_answers" USING btree ("feedback_id","question_id");
--> statement-breakpoint
CREATE INDEX "feedback_answers_feedback_idx" ON "feedback_answers" USING btree ("feedback_id");

