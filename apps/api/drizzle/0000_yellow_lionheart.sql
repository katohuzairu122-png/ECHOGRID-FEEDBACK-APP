CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text,
	"industry" text,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"default_timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "businesses_slug_unique" UNIQUE("slug"),
	CONSTRAINT "businesses_status_check" CHECK ("businesses"."status" IN ('active', 'suspended', 'archived')),
	CONSTRAINT "businesses_default_locale_check" CHECK ("businesses"."default_locale" IN ('en', 'es', 'fr'))
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state_province" text,
	"postal_code" text,
	"country_code" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "branches_status_check" CHECK ("branches"."status" IN ('active', 'inactive', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"last_login_at" timestamp with time zone,
	"platform_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('invited', 'active', 'suspended', 'deactivated')),
	CONSTRAINT "users_platform_role_check" CHECK ("users"."platform_role" IS NULL OR "users"."platform_role" IN ('support', 'billing', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "user_business_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"user_agent" text,
	"ip_address" text
);
--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"token" text NOT NULL,
	"type" text DEFAULT 'feedback' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "qr_codes_token_unique" UNIQUE("token"),
	CONSTRAINT "qr_codes_status_check" CHECK ("qr_codes"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"qr_code_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"customer_name" text,
	"customer_email" text,
	"customer_phone" text,
	"status" text DEFAULT 'new' NOT NULL,
	"sentiment" text,
	"sentiment_score" real,
	"analysis_status" text DEFAULT 'pending' NOT NULL,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "feedback_rating_check" CHECK ("feedback"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" IN ('new', 'reviewed')),
	CONSTRAINT "feedback_sentiment_check" CHECK ("feedback"."sentiment" IS NULL OR "feedback"."sentiment" IN ('positive', 'neutral', 'negative')),
	CONSTRAINT "feedback_sentiment_score_check" CHECK ("feedback"."sentiment_score" IS NULL OR "feedback"."sentiment_score" BETWEEN -1 AND 1),
	CONSTRAINT "feedback_analysis_status_check" CHECK ("feedback"."analysis_status" IN ('pending', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "feedback_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid,
	"period_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"feedback_count" integer NOT NULL,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"neutral_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"summary" text NOT NULL,
	"recommendations" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "feedback_summaries_period_type_check" CHECK ("feedback_summaries"."period_type" IN ('weekly', 'monthly')),
	CONSTRAINT "feedback_summaries_period_range_check" CHECK ("feedback_summaries"."period_end" > "feedback_summaries"."period_start"),
	CONSTRAINT "feedback_summaries_counts_check" CHECK ("feedback_summaries"."feedback_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"full_name" text,
	"email" text,
	"birthday" date,
	"phone_verified_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "customers_status_check" CHECK ("customers"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_points" integer NOT NULL,
	"benefits" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "loyalty_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"points_cost" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "loyalty_rewards_status_check" CHECK ("loyalty_rewards"."status" IN ('active', 'inactive')),
	CONSTRAINT "loyalty_rewards_points_cost_check" CHECK ("loyalty_rewards"."points_cost" > 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"tier_id" uuid,
	"referred_by_customer_id" uuid,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "loyalty_accounts_status_check" CHECK ("loyalty_accounts"."status" IN ('active', 'suspended')),
	CONSTRAINT "loyalty_accounts_points_check" CHECK ("loyalty_accounts"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"points" integer NOT NULL,
	"related_reward_id" uuid,
	"related_qr_code_id" uuid,
	"purchase_amount" numeric(10, 2),
	"redemption_code" text,
	"redemption_confirmed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "loyalty_transactions_redemption_code_unique" UNIQUE("redemption_code"),
	CONSTRAINT "loyalty_transactions_type_check" CHECK ("loyalty_transactions"."type" IN ('checkin', 'purchase', 'redemption', 'referral_bonus', 'birthday_bonus', 'adjustment'))
);
--> statement-breakpoint
CREATE TABLE "loyalty_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"points_per_checkin" integer DEFAULT 10 NOT NULL,
	"points_per_currency_unit" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"referral_bonus_points" integer DEFAULT 50 NOT NULL,
	"birthday_bonus_points" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "loyalty_settings_points_per_checkin_check" CHECK ("loyalty_settings"."points_per_checkin" >= 0),
	CONSTRAINT "loyalty_settings_points_per_currency_unit_check" CHECK ("loyalty_settings"."points_per_currency_unit" >= 0),
	CONSTRAINT "loyalty_settings_referral_bonus_check" CHECK ("loyalty_settings"."referral_bonus_points" >= 0),
	CONSTRAINT "loyalty_settings_birthday_bonus_check" CHECK ("loyalty_settings"."birthday_bonus_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"customer_id" uuid,
	"event_type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "notification_preferences_exactly_one_recipient_check" CHECK (("notification_preferences"."user_id" IS NULL) <> ("notification_preferences"."customer_id" IS NULL)),
	CONSTRAINT "notification_preferences_event_type_check" CHECK ("notification_preferences"."event_type" IN ('feedback_received', 'summary_ready', 'redemption_pending', 'points_earned', 'tier_upgraded', 'reward_redeemed')),
	CONSTRAINT "notification_preferences_channel_check" CHECK ("notification_preferences"."channel" IN ('email', 'sms', 'push'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"customer_id" uuid,
	"event_type" text NOT NULL,
	"channel" text NOT NULL,
	"recipient_address" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_exactly_one_recipient_check" CHECK (("notifications"."user_id" IS NULL) <> ("notifications"."customer_id" IS NULL)),
	CONSTRAINT "notifications_event_type_check" CHECK ("notifications"."event_type" IN ('feedback_received', 'summary_ready', 'redemption_pending', 'points_earned', 'tier_upgraded', 'reward_redeemed')),
	CONSTRAINT "notifications_channel_check" CHECK ("notifications"."channel" IN ('email', 'sms', 'push')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "business_notification_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"max_sms_per_day" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "business_notification_settings_max_sms_check" CHECK ("business_notification_settings"."max_sms_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_monthly_cents" integer NOT NULL,
	"price_yearly_cents" integer,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_price_id_monthly" text,
	"stripe_price_id_yearly" text,
	"max_branches" integer,
	"max_users" integer,
	"features" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default_trial" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "subscription_plans_key_unique" UNIQUE("key"),
	CONSTRAINT "subscription_plans_price_monthly_check" CHECK ("subscription_plans"."price_monthly_cents" >= 0),
	CONSTRAINT "subscription_plans_price_yearly_check" CHECK ("subscription_plans"."price_yearly_cents" IS NULL OR "subscription_plans"."price_yearly_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "business_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text DEFAULT 'trialing' NOT NULL,
	"billing_interval" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "business_subscriptions_status_check" CHECK ("business_subscriptions"."status" IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid')),
	CONSTRAINT "business_subscriptions_billing_interval_check" CHECK ("business_subscriptions"."billing_interval" IS NULL OR "business_subscriptions"."billing_interval" IN ('month', 'year'))
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_business_roles" ADD CONSTRAINT "user_business_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_business_roles" ADD CONSTRAINT "user_business_roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_business_roles" ADD CONSTRAINT "user_business_roles_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_business_roles" ADD CONSTRAINT "user_business_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_qr_code_id_qr_codes_id_fk" FOREIGN KEY ("qr_code_id") REFERENCES "public"."qr_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_summaries" ADD CONSTRAINT "feedback_summaries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_summaries" ADD CONSTRAINT "feedback_summaries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_tier_id_loyalty_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."loyalty_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_referred_by_customer_id_customers_id_fk" FOREIGN KEY ("referred_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_related_reward_id_loyalty_rewards_id_fk" FOREIGN KEY ("related_reward_id") REFERENCES "public"."loyalty_rewards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_related_qr_code_id_qr_codes_id_fk" FOREIGN KEY ("related_qr_code_id") REFERENCES "public"."qr_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_notification_settings" ADD CONSTRAINT "business_notification_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_business_id_slug_key" ON "branches" USING btree ("business_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_business_id_name_key" ON "roles" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "ubr_user_id_idx" ON "user_business_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ubr_business_id_idx" ON "user_business_roles" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ubr_branch_scoped_unique" ON "user_business_roles" USING btree ("user_id","business_id","branch_id","role_id") WHERE "user_business_roles"."branch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ubr_business_wide_unique" ON "user_business_roles" USING btree ("user_id","business_id","role_id") WHERE "user_business_roles"."branch_id" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_business_id_created_at_idx" ON "audit_log" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_codes_branch_type_active_key" ON "qr_codes" USING btree ("branch_id","type") WHERE "qr_codes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "feedback_branch_created_idx" ON "feedback" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_business_created_idx" ON "feedback" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_business_sentiment_idx" ON "feedback" USING btree ("business_id","sentiment");--> statement-breakpoint
CREATE INDEX "feedback_analysis_status_idx" ON "feedback" USING btree ("analysis_status");--> statement-breakpoint
CREATE INDEX "feedback_summaries_business_period_idx" ON "feedback_summaries" USING btree ("business_id","period_type","period_start");--> statement-breakpoint
CREATE INDEX "feedback_summaries_branch_period_idx" ON "feedback_summaries" USING btree ("branch_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_tiers_business_name_key" ON "loyalty_tiers" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_accounts_customer_business_key" ON "loyalty_accounts" USING btree ("customer_id","business_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_account_created_idx" ON "loyalty_transactions" USING btree ("loyalty_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_transactions_redemption_code_key" ON "loyalty_transactions" USING btree ("redemption_code") WHERE "loyalty_transactions"."redemption_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_settings_business_id_key" ON "loyalty_settings" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_event_channel_key" ON "notification_preferences" USING btree ("business_id","user_id","event_type","channel") WHERE "notification_preferences"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_customer_event_channel_key" ON "notification_preferences" USING btree ("business_id","customer_id","event_type","channel") WHERE "notification_preferences"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_preferences_user_idx" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_preferences_customer_idx" ON "notification_preferences" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "notifications_business_created_idx" ON "notifications" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_customer_idx" ON "notifications" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "notifications_business_channel_created_idx" ON "notifications" USING btree ("business_id","channel","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_notification_settings_business_id_key" ON "business_notification_settings" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_key_key" ON "subscription_plans" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_one_default_trial_idx" ON "subscription_plans" USING btree ("is_default_trial") WHERE "subscription_plans"."is_default_trial" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "business_subscriptions_business_id_key" ON "business_subscriptions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "business_subscriptions_stripe_customer_id_idx" ON "business_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "business_subscriptions_stripe_subscription_id_idx" ON "business_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "business_subscriptions_status_idx" ON "business_subscriptions" USING btree ("status");