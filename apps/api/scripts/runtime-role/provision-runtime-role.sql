-- R8-G: provision the least-privilege application runtime role (idempotent)
-- GENERATED from scripts/runtime-role/runtime-role-manifest.json by scripts/runtime-role/generate.mjs. DO NOT EDIT BY HAND.
-- Contains no secret, no password and no real login name. NOT part of the Drizzle journal: it is run by the schema owner (migration
-- authority) after migrations, in a controlled workflow. It has NOT been run against staging or production.

-- Run as the schema OWNER / migrator. Before running, create the application LOGIN out of band (the password never appears in this repository):
--   CREATE ROLE <runtime_login> LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- then replace REPLACE_WITH_RUNTIME_LOGIN below with that name (or pass it through your provisioning tool).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'echogrid_app_runtime') THEN
    CREATE ROLE echogrid_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
-- A non-superuser owner (the production migrator) may not run ALTER ROLE with NOSUPERUSER / NOBYPASSRLS / NOREPLICATION even to restate a value, so
-- the attributes are VERIFIED, not altered: a pre-existing role with any dangerous attribute stops the script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'echogrid_app_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'R8G: role echogrid_app_runtime exists with unsafe attributes (superuser, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or LOGIN); refusing to continue';
  END IF;
END
$$;

-- No ownership and no object creation: usage only.
REVOKE ALL ON SCHEMA public FROM echogrid_app_runtime;
GRANT USAGE ON SCHEMA public TO echogrid_app_runtime;

-- Tables the runtime may use, with exactly the verbs the application code uses (see the manifest). Everything else gets nothing.
-- Tables that do not exist yet in the target database are skipped, so the script is safe at any migration level.
DO $$
DECLARE
  rec record;
  grants text[][] := ARRAY[
    ['ai_usage_log', 'INSERT, SELECT, UPDATE'],
    ['audit_log', 'INSERT, SELECT'],
    ['b2b_participations', 'INSERT, SELECT, UPDATE'],
    ['b2b_terms_versions', 'SELECT'],
    ['benefit_application_compensations', 'INSERT, SELECT'],
    ['benefit_application_intents', 'INSERT, SELECT, UPDATE'],
    ['benefit_application_transitions', 'INSERT, SELECT'],
    ['benefit_provider_attempts', 'INSERT, SELECT'],
    ['benefit_provider_observations', 'INSERT, SELECT'],
    ['benefit_reconciliation_attempts', 'INSERT, SELECT, UPDATE'],
    ['billing_partner_credit_applications', 'INSERT, SELECT'],
    ['branches', 'INSERT, SELECT, UPDATE'],
    ['business_categories', 'SELECT'],
    ['business_closure_requests', 'INSERT, SELECT, UPDATE'],
    ['business_customer_memberships', 'INSERT, SELECT, UPDATE'],
    ['business_notification_settings', 'INSERT, SELECT, UPDATE'],
    ['business_profile_revision_locations', 'DELETE, INSERT, SELECT'],
    ['business_profile_revision_translations', 'DELETE, INSERT, SELECT'],
    ['business_profile_revisions', 'INSERT, SELECT, UPDATE'],
    ['business_public_profiles', 'INSERT, SELECT, UPDATE'],
    ['business_subscriptions', 'INSERT, SELECT, UPDATE'],
    ['businesses', 'INSERT, SELECT, UPDATE'],
    ['community_memberships', 'INSERT, SELECT, UPDATE'],
    ['community_pilot_eligibility_events', 'INSERT, SELECT'],
    ['community_point_accounts', 'INSERT, SELECT, UPDATE'],
    ['community_point_award_decisions', 'INSERT, SELECT, UPDATE'],
    ['community_point_rules', 'INSERT, SELECT, UPDATE'],
    ['community_point_transactions', 'INSERT, SELECT'],
    ['community_terms_current', 'SELECT'],
    ['community_terms_publications', 'SELECT'],
    ['consent_grants', 'INSERT, SELECT, UPDATE'],
    ['conversations', 'INSERT, SELECT, UPDATE'],
    ['critical_incidents', 'INSERT, SELECT, UPDATE'],
    ['customer_action_authorizations', 'INSERT, SELECT, UPDATE'],
    ['customer_auth_challenges', 'INSERT, SELECT, UPDATE'],
    ['customer_auth_events', 'DELETE, INSERT, SELECT'],
    ['customer_credentials', 'INSERT, SELECT, UPDATE'],
    ['customer_deletion_requests', 'INSERT, SELECT, UPDATE'],
    ['customer_invitations', 'INSERT, SELECT, UPDATE'],
    ['customer_onboarding_events', 'INSERT, SELECT'],
    ['customer_recovery_attempts', 'INSERT, SELECT, UPDATE'],
    ['customer_recovery_code_sets', 'INSERT, SELECT, UPDATE'],
    ['customer_recovery_codes', 'INSERT, SELECT, UPDATE'],
    ['customer_referral_events', 'INSERT, SELECT'],
    ['customer_referrals', 'INSERT, SELECT'],
    ['customer_refresh_tokens', 'DELETE, INSERT, SELECT, UPDATE'],
    ['customer_sanctions', 'INSERT, SELECT'],
    ['customer_sessions', 'DELETE, INSERT, SELECT, UPDATE'],
    ['customers', 'INSERT, SELECT, UPDATE'],
    ['feedback', 'INSERT, SELECT, UPDATE'],
    ['feedback_answers', 'INSERT, SELECT'],
    ['feedback_form_versions', 'INSERT, SELECT'],
    ['feedback_forms', 'INSERT, SELECT'],
    ['feedback_questions', 'INSERT, SELECT'],
    ['feedback_summaries', 'INSERT, SELECT'],
    ['fraud_signals', 'INSERT, SELECT, UPDATE'],
    ['heta_provenance_comparisons', 'INSERT, SELECT'],
    ['heta_reconciliation_work', 'INSERT, SELECT, UPDATE'],
    ['heta_record_revisions', 'INSERT, SELECT'],
    ['loyalty_accounts', 'INSERT, SELECT, UPDATE'],
    ['loyalty_purchase_events', 'INSERT, SELECT'],
    ['loyalty_rewards', 'INSERT, SELECT, UPDATE'],
    ['loyalty_settings', 'INSERT, SELECT, UPDATE'],
    ['loyalty_tiers', 'INSERT, SELECT, UPDATE'],
    ['loyalty_transactions', 'INSERT, SELECT, UPDATE'],
    ['messages', 'INSERT, SELECT, UPDATE'],
    ['network_engagement_events', 'INSERT, SELECT'],
    ['network_follows', 'DELETE, INSERT, SELECT'],
    ['network_post_revisions', 'INSERT, SELECT, UPDATE'],
    ['network_posts', 'INSERT, SELECT, UPDATE'],
    ['network_revision_approvals', 'INSERT, SELECT'],
    ['notification_preferences', 'INSERT, SELECT, UPDATE'],
    ['notifications', 'INSERT, SELECT, UPDATE'],
    ['orphan_reward_claims', 'INSERT, SELECT, UPDATE'],
    ['orphan_settlement_events', 'INSERT, SELECT'],
    ['orphan_settlements', 'INSERT, SELECT, UPDATE'],
    ['otp_codes', 'DELETE, INSERT, SELECT, UPDATE'],
    ['otp_request_cooldowns', 'DELETE, INSERT, SELECT, UPDATE'],
    ['partner_credit_accounts', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_award_decisions', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_award_disputes', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_corrections', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_dispute_events', 'INSERT, SELECT'],
    ['partner_credit_ledger', 'INSERT, SELECT'],
    ['partner_credit_lots', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_policies', 'SELECT'],
    ['partner_credit_recovery_obligations', 'INSERT, SELECT, UPDATE'],
    ['partner_credit_reservations', 'INSERT, SELECT, UPDATE'],
    ['partner_program_enrollments', 'INSERT, SELECT'],
    ['password_reset_tokens', 'INSERT, SELECT, UPDATE'],
    ['permissions', 'INSERT, SELECT'],
    ['qr_codes', 'INSERT, SELECT, UPDATE'],
    ['qr_scan_events', 'INSERT, SELECT'],
    ['qualification_evidence_consumptions', 'INSERT, SELECT'],
    ['qualification_rule_versions', 'INSERT, SELECT, UPDATE'],
    ['refresh_tokens', 'DELETE, INSERT, SELECT, UPDATE'],
    ['role_permissions', 'DELETE, INSERT, SELECT'],
    ['roles', 'INSERT, SELECT, UPDATE'],
    ['s08_allocation_freeze_items', 'INSERT, SELECT'],
    ['s08_allocation_freezes', 'INSERT, SELECT'],
    ['shuffle_allocation_events', 'INSERT, SELECT'],
    ['shuffle_campaign_versions', 'INSERT, SELECT'],
    ['shuffle_campaigns', 'INSERT, SELECT, UPDATE'],
    ['shuffle_eligibility_snapshots', 'INSERT, SELECT'],
    ['shuffle_entries', 'INSERT, SELECT, UPDATE'],
    ['shuffle_invitation_events', 'INSERT, SELECT'],
    ['shuffle_invitations', 'INSERT, SELECT, UPDATE'],
    ['shuffle_notification_intents', 'INSERT, SELECT'],
    ['shuffle_selection_results', 'INSERT, SELECT'],
    ['stripe_evidence_control_events', 'INSERT, SELECT'],
    ['stripe_evidence_keys', 'INSERT, SELECT'],
    ['stripe_provider_event_conflicts', 'INSERT, SELECT'],
    ['stripe_provider_event_dispositions', 'INSERT, SELECT'],
    ['stripe_provider_events', 'INSERT, SELECT'],
    ['stripe_provider_malformed_receipts', 'INSERT, SELECT'],
    ['stripe_subscription_tier_observations', 'INSERT, SELECT'],
    ['subscription_plans', 'INSERT, SELECT, UPDATE'],
    ['survey_answers', 'INSERT, SELECT'],
    ['survey_campaigns', 'INSERT, SELECT, UPDATE'],
    ['survey_participations', 'INSERT, SELECT, UPDATE'],
    ['survey_questions', 'INSERT, SELECT'],
    ['survey_versions', 'INSERT, SELECT, UPDATE'],
    ['surveys', 'INSERT, SELECT, UPDATE'],
    ['team_invitations', 'INSERT, SELECT, UPDATE'],
    ['tentaship_badge_awards', 'INSERT, SELECT'],
    ['tentaship_badge_definition_versions', 'INSERT, SELECT, UPDATE'],
    ['tentaship_badge_definitions', 'INSERT, SELECT'],
    ['tentaship_badge_revocations', 'INSERT, SELECT'],
    ['user_business_roles', 'INSERT, SELECT, UPDATE'],
    ['users', 'INSERT, SELECT, UPDATE'],
    ['visit_sessions', 'INSERT, SELECT, UPDATE']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(grants, 1) LOOP
    IF to_regclass('public.' || grants[i][1]) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM echogrid_app_runtime', grants[i][1]);
      EXECUTE format('GRANT %s ON TABLE public.%I TO echogrid_app_runtime', grants[i][2], grants[i][1]);
    END IF;
  END LOOP;
END
$$;

-- Tables the runtime must NOT touch (dedicated-role families, operator-only tables, dormant tables): explicitly revoked.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_category_translations', 'legal_holds', 'onboarding_erasure_operations', 'partner_credit_multiunit_lot_allocations', 'partner_credit_multiunit_movements', 'partner_credit_settlement_authorizations', 'privacy_request_transitions', 'privacy_requests', 'retention_policies', 'retention_runs', 'settlement_custody_authorization_links', 'signed_evidence_events', 'signed_evidence_records', 'stripe_read_authorization_events', 'stripe_read_authorization_policy', 'stripe_read_authorizations', 'stripe_read_policy_changes', 'stripe_read_policy_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM echogrid_app_runtime', t);
    END IF;
  END LOOP;
END
$$;

-- Sequences used by the tables above (ids); nothing else.
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['benefit_application_transitions_seq_seq', 'community_pilot_eligibility_events_seq_seq', 'partner_credit_dispute_events_seq_seq', 'stripe_evidence_control_events_seq_seq', 'stripe_provider_event_dispositions_seq_seq'] LOOP
    IF to_regclass('public.' || s) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM echogrid_app_runtime', s);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO echogrid_app_runtime', s);
    END IF;
  END LOOP;
END
$$;

-- Attach the login. INHERIT is required for the login to use the group's grants; the group is a member of nothing.
GRANT echogrid_app_runtime TO REPLACE_WITH_RUNTIME_LOGIN;
