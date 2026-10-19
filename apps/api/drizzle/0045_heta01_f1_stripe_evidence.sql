CREATE TABLE "stripe_evidence_control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "stripe_evidence_control_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"stream" text,
	"cause" text,
	"dedupe_key" text,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"actor" text NOT NULL,
	"commit_sha" text,
	"approval_ref" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "stripe_evidence_control_kind_check" CHECK ("stripe_evidence_control_events"."event_kind" IN ('account_provenance_verified','capture_mode_changed','capture_heartbeat','heartbeat_gap_detected','capture_precondition_failed','capture_error_observed','oversize_rejected','reconciliation_run','coverage_gap_unrecovered','ucw_opened','ucw_closed','kek_generated','kek_rotated','kek_destroyed','retention_policy_applied','legal_hold_set','legal_hold_released','forensic_export_registered','forensic_export_destroyed')),
	CONSTRAINT "stripe_evidence_control_details_check" CHECK (jsonb_typeof("stripe_evidence_control_events"."details") = 'object' AND pg_column_size("stripe_evidence_control_events"."details") <= 8192),
	CONSTRAINT "stripe_evidence_control_stream_dedupe_required" CHECK ("stripe_evidence_control_events"."event_kind" NOT IN ('capture_heartbeat','heartbeat_gap_detected','capture_precondition_failed','capture_error_observed','oversize_rejected','ucw_opened','ucw_closed') OR ("stripe_evidence_control_events"."stream" IS NOT NULL AND "stripe_evidence_control_events"."dedupe_key" IS NOT NULL)),
	CONSTRAINT "stripe_evidence_control_cause_required" CHECK ("stripe_evidence_control_events"."event_kind" NOT IN ('ucw_opened','ucw_closed','heartbeat_gap_detected') OR "stripe_evidence_control_events"."cause" IN ('capture_off','precondition_failed','http_413','http_500','heartbeat_gap','oversize_unresolved','reconciliation_incomplete','unrecorded_mode_change')),
	CONSTRAINT "stripe_evidence_control_attestation_result" CHECK ("stripe_evidence_control_events"."event_kind" <> 'account_provenance_verified' OR "stripe_evidence_control_events"."details"->>'result' IN ('passed','failed')),
	CONSTRAINT "stripe_evidence_control_kek_destroyed_claim" CHECK ("stripe_evidence_control_events"."event_kind" <> 'kek_destroyed' OR ("stripe_evidence_control_events"."details"->>'claim' IN ('irrecoverable_verified','conditional') AND ("stripe_evidence_control_events"."details"->>'claim' <> 'irrecoverable_verified' OR (jsonb_typeof("stripe_evidence_control_events"."details"->'evidence') = 'object' AND "stripe_evidence_control_events"."details"->'evidence'->>'e1_custody_inventory' = 'true' AND "stripe_evidence_control_events"."details"->'evidence'->>'e2_two_person_attestation' = 'true' AND "stripe_evidence_control_events"."details"->'evidence'->>'e3_platform_evidence' = 'true' AND "stripe_evidence_control_events"."details"->'evidence'->>'e4_independent_signoff' = 'true' AND "stripe_evidence_control_events"."details"->'evidence'->>'e5_negative_tests_run' = 'true' AND jsonb_typeof("stripe_evidence_control_events"."details"->'evidence_refs') = 'array' AND jsonb_array_length("stripe_evidence_control_events"."details"->'evidence_refs') > 0))))
);
--> statement-breakpoint
CREATE TABLE "stripe_evidence_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort" text NOT NULL,
	"kek_version" text NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"wrap_nonce" "bytea" NOT NULL,
	"wrap_algorithm" text NOT NULL,
	"dek_fingerprint" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_evidence_keys_cohort_check" CHECK ("stripe_evidence_keys"."cohort" ~ '^[0-9]{4}-(0[1-9]|1[0-2])(:[a-z0-9_]+)?$'),
	CONSTRAINT "stripe_evidence_keys_algorithm_check" CHECK ("stripe_evidence_keys"."wrap_algorithm" = 'AES-256-GCM')
);
--> statement-breakpoint
CREATE TABLE "stripe_provider_event_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_record_id" uuid NOT NULL,
	"conflict_kind" text NOT NULL,
	"conflicting_provenance" text NOT NULL,
	"conflicting_sha256" "bytea" NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_key_cohort" text NOT NULL,
	"kek_version" text NOT NULL,
	"sig_header_timestamp" bigint,
	"sig_scheme" text,
	"signing_secret_label" text,
	"verified_at" timestamp with time zone,
	"verifier_version" text,
	"retrieved_at" timestamp with time zone,
	"retrieval_run_id" uuid,
	"retrieval_api_version" text,
	"detected_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_provider_event_conflicts_kind_check" CHECK ("stripe_provider_event_conflicts"."conflict_kind" IN ('webhook_digest_mismatch','provider_field_mismatch')),
	CONSTRAINT "stripe_provider_event_conflicts_provenance_check" CHECK ("stripe_provider_event_conflicts"."conflicting_provenance" IN ('webhook_signature','api_retrieval')),
	CONSTRAINT "stripe_provider_event_conflicts_digest_check" CHECK (octet_length("stripe_provider_event_conflicts"."conflicting_sha256") = 32),
	CONSTRAINT "stripe_provider_event_conflicts_nonce_check" CHECK (octet_length("stripe_provider_event_conflicts"."payload_nonce") = 12),
	CONSTRAINT "stripe_provider_event_conflicts_provenance_groups_check" CHECK (("stripe_provider_event_conflicts"."conflicting_provenance" = 'webhook_signature' AND "stripe_provider_event_conflicts"."sig_header_timestamp" IS NOT NULL AND "stripe_provider_event_conflicts"."sig_scheme" = 'v1' AND "stripe_provider_event_conflicts"."signing_secret_label" IS NOT NULL AND "stripe_provider_event_conflicts"."verified_at" IS NOT NULL AND "stripe_provider_event_conflicts"."verifier_version" IS NOT NULL AND "stripe_provider_event_conflicts"."retrieved_at" IS NULL AND "stripe_provider_event_conflicts"."retrieval_run_id" IS NULL AND "stripe_provider_event_conflicts"."retrieval_api_version" IS NULL) OR ("stripe_provider_event_conflicts"."conflicting_provenance" = 'api_retrieval' AND "stripe_provider_event_conflicts"."retrieved_at" IS NOT NULL AND "stripe_provider_event_conflicts"."retrieval_run_id" IS NOT NULL AND "stripe_provider_event_conflicts"."retrieval_api_version" IS NOT NULL AND "stripe_provider_event_conflicts"."sig_header_timestamp" IS NULL AND "stripe_provider_event_conflicts"."sig_scheme" IS NULL AND "stripe_provider_event_conflicts"."signing_secret_label" IS NULL AND "stripe_provider_event_conflicts"."verified_at" IS NULL AND "stripe_provider_event_conflicts"."verifier_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stripe_provider_event_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "stripe_provider_event_dispositions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_record_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor" text NOT NULL,
	"rule_version" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"business_id" uuid,
	"attempt_no" integer,
	"claimant" text,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "stripe_provider_event_dispositions_kind_check" CHECK ("stripe_provider_event_dispositions"."disposition" IN ('capture_committed','processing_claimed','quarantined','out_of_scope_type','eligible_for_projection','projection_applied','projection_failed','projection_skipped','provider_corroborated','reconciliation_confirmed','recovered_during_uncertified_window')),
	CONSTRAINT "stripe_provider_event_dispositions_claim_fields_check" CHECK ("stripe_provider_event_dispositions"."disposition" <> 'processing_claimed' OR ("stripe_provider_event_dispositions"."attempt_no" IS NOT NULL AND "stripe_provider_event_dispositions"."claimant" IS NOT NULL AND "stripe_provider_event_dispositions"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stripe_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receiving_account_id" text NOT NULL,
	"event_account_id" text NOT NULL,
	"account_scope" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_event_id" text NOT NULL,
	"provenance" text NOT NULL,
	"attestation_event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"api_version" text,
	"provider_created_unix" bigint NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"payload_sha256" "bytea" NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_key_cohort" text NOT NULL,
	"kek_version" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"sig_header_timestamp" bigint,
	"sig_scheme" text,
	"signing_secret_label" text,
	"verified_at" timestamp with time zone,
	"verifier_version" text,
	"retrieved_at" timestamp with time zone,
	"retrieval_run_id" uuid,
	"retrieval_api_version" text,
	"stripe_request_id" text,
	"stripe_idempotency_key" text,
	"object_type" text,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"claimed_business_id" text,
	"capture_mode" text NOT NULL,
	"projection_mode" text NOT NULL,
	"retention_policy_version" text NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "stripe_provider_events_receiving_acct_check" CHECK ("stripe_provider_events"."receiving_account_id" ~ '^acct_[A-Za-z0-9]+$'),
	CONSTRAINT "stripe_provider_events_event_acct_check" CHECK ("stripe_provider_events"."event_account_id" ~ '^acct_[A-Za-z0-9]+$'),
	CONSTRAINT "stripe_provider_events_scope_check" CHECK (("stripe_provider_events"."account_scope" = 'direct' AND "stripe_provider_events"."event_account_id" = "stripe_provider_events"."receiving_account_id") OR ("stripe_provider_events"."account_scope" = 'connect' AND "stripe_provider_events"."event_account_id" <> "stripe_provider_events"."receiving_account_id")),
	CONSTRAINT "stripe_provider_events_event_id_check" CHECK ("stripe_provider_events"."stripe_event_id" ~ '^evt_[A-Za-z0-9_]+$'),
	CONSTRAINT "stripe_provider_events_provenance_check" CHECK ("stripe_provider_events"."provenance" IN ('webhook_signature','api_retrieval')),
	CONSTRAINT "stripe_provider_events_created_check" CHECK ("stripe_provider_events"."provider_created_at" = to_timestamp("stripe_provider_events"."provider_created_unix")),
	CONSTRAINT "stripe_provider_events_digest_check" CHECK (octet_length("stripe_provider_events"."payload_sha256") = 32),
	CONSTRAINT "stripe_provider_events_nonce_check" CHECK (octet_length("stripe_provider_events"."payload_nonce") = 12),
	CONSTRAINT "stripe_provider_events_bytes_check" CHECK ("stripe_provider_events"."payload_bytes" > 0 AND "stripe_provider_events"."payload_bytes" <= 16777216),
	CONSTRAINT "stripe_provider_events_sig_scheme_check" CHECK ("stripe_provider_events"."sig_scheme" IS NULL OR "stripe_provider_events"."sig_scheme" = 'v1'),
	CONSTRAINT "stripe_provider_events_provenance_groups_check" CHECK (("stripe_provider_events"."provenance" = 'webhook_signature' AND "stripe_provider_events"."sig_header_timestamp" IS NOT NULL AND "stripe_provider_events"."sig_scheme" IS NOT NULL AND "stripe_provider_events"."signing_secret_label" IS NOT NULL AND "stripe_provider_events"."verified_at" IS NOT NULL AND "stripe_provider_events"."verifier_version" IS NOT NULL AND "stripe_provider_events"."retrieved_at" IS NULL AND "stripe_provider_events"."retrieval_run_id" IS NULL AND "stripe_provider_events"."retrieval_api_version" IS NULL) OR ("stripe_provider_events"."provenance" = 'api_retrieval' AND "stripe_provider_events"."retrieved_at" IS NOT NULL AND "stripe_provider_events"."retrieval_run_id" IS NOT NULL AND "stripe_provider_events"."retrieval_api_version" IS NOT NULL AND "stripe_provider_events"."sig_header_timestamp" IS NULL AND "stripe_provider_events"."sig_scheme" IS NULL AND "stripe_provider_events"."signing_secret_label" IS NULL AND "stripe_provider_events"."verified_at" IS NULL AND "stripe_provider_events"."verifier_version" IS NULL)),
	CONSTRAINT "stripe_provider_events_capture_mode_check" CHECK ("stripe_provider_events"."capture_mode" = 'enforced'),
	CONSTRAINT "stripe_provider_events_projection_mode_check" CHECK ("stripe_provider_events"."projection_mode" = 'legacy')
);
--> statement-breakpoint
CREATE TABLE "stripe_provider_malformed_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"payload_sha256" "bytea" NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_key_cohort" text NOT NULL,
	"kek_version" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"sig_header_timestamp" bigint NOT NULL,
	"sig_scheme" text NOT NULL,
	"signing_secret_label" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"verifier_version" text NOT NULL,
	"parse_status" text NOT NULL,
	"shape_defects" text[] NOT NULL,
	"reason_codes" text[] NOT NULL,
	"receiving_account_id" text NOT NULL,
	"attestation_event_id" uuid NOT NULL,
	"capture_mode" text NOT NULL,
	"projection_mode" text NOT NULL,
	"retention_policy_version" text NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "stripe_provider_malformed_receipts_digest_check" CHECK (octet_length("stripe_provider_malformed_receipts"."payload_sha256") = 32),
	CONSTRAINT "stripe_provider_malformed_receipts_nonce_check" CHECK (octet_length("stripe_provider_malformed_receipts"."payload_nonce") = 12),
	CONSTRAINT "stripe_provider_malformed_receipts_bytes_check" CHECK ("stripe_provider_malformed_receipts"."payload_bytes" > 0 AND "stripe_provider_malformed_receipts"."payload_bytes" <= 16777216),
	CONSTRAINT "stripe_provider_malformed_receipts_sig_scheme_check" CHECK ("stripe_provider_malformed_receipts"."sig_scheme" = 'v1'),
	CONSTRAINT "stripe_provider_malformed_receipts_parse_status_check" CHECK ("stripe_provider_malformed_receipts"."parse_status" IN ('not_json','json_non_object','json_object_invalid_envelope')),
	CONSTRAINT "stripe_provider_malformed_receipts_defects_check" CHECK (cardinality("stripe_provider_malformed_receipts"."shape_defects") > 0 AND "stripe_provider_malformed_receipts"."shape_defects" <@ ARRAY['missing_id','bad_id','missing_created','bad_created','missing_livemode','bad_livemode','missing_type','bad_type','missing_data_object','bad_data_object']::text[]),
	CONSTRAINT "stripe_provider_malformed_receipts_reason_check" CHECK ('QR_SHAPE_INVALID' = ANY("stripe_provider_malformed_receipts"."reason_codes")),
	CONSTRAINT "stripe_provider_malformed_receipts_acct_check" CHECK ("stripe_provider_malformed_receipts"."receiving_account_id" ~ '^acct_[A-Za-z0-9]+$'),
	CONSTRAINT "stripe_provider_malformed_receipts_capture_mode_check" CHECK ("stripe_provider_malformed_receipts"."capture_mode" = 'enforced'),
	CONSTRAINT "stripe_provider_malformed_receipts_projection_mode_check" CHECK ("stripe_provider_malformed_receipts"."projection_mode" = 'legacy')
);
--> statement-breakpoint
ALTER TABLE "stripe_provider_event_conflicts" ADD CONSTRAINT "stripe_provider_event_conflicts_event_record_id_stripe_provider_events_id_fk" FOREIGN KEY ("event_record_id") REFERENCES "public"."stripe_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_event_conflicts" ADD CONSTRAINT "stripe_provider_event_conflicts_retrieval_run_id_stripe_evidence_control_events_id_fk" FOREIGN KEY ("retrieval_run_id") REFERENCES "public"."stripe_evidence_control_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_event_conflicts" ADD CONSTRAINT "stripe_provider_event_conflicts_key_fk" FOREIGN KEY ("payload_key_cohort","kek_version") REFERENCES "public"."stripe_evidence_keys"("cohort","kek_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_event_dispositions" ADD CONSTRAINT "stripe_provider_event_dispositions_event_record_id_stripe_provider_events_id_fk" FOREIGN KEY ("event_record_id") REFERENCES "public"."stripe_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_event_dispositions" ADD CONSTRAINT "stripe_provider_event_dispositions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_events" ADD CONSTRAINT "stripe_provider_events_attestation_event_id_stripe_evidence_control_events_id_fk" FOREIGN KEY ("attestation_event_id") REFERENCES "public"."stripe_evidence_control_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_events" ADD CONSTRAINT "stripe_provider_events_retrieval_run_id_stripe_evidence_control_events_id_fk" FOREIGN KEY ("retrieval_run_id") REFERENCES "public"."stripe_evidence_control_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_events" ADD CONSTRAINT "stripe_provider_events_key_fk" FOREIGN KEY ("payload_key_cohort","kek_version") REFERENCES "public"."stripe_evidence_keys"("cohort","kek_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_malformed_receipts" ADD CONSTRAINT "stripe_provider_malformed_receipts_attestation_event_id_stripe_evidence_control_events_id_fk" FOREIGN KEY ("attestation_event_id") REFERENCES "public"."stripe_evidence_control_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_provider_malformed_receipts" ADD CONSTRAINT "stripe_provider_malformed_receipts_key_fk" FOREIGN KEY ("payload_key_cohort","kek_version") REFERENCES "public"."stripe_evidence_keys"("cohort","kek_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_evidence_control_dedupe_key_uq" ON "stripe_evidence_control_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "stripe_evidence_control_stream_kind_seq_idx" ON "stripe_evidence_control_events" USING btree ("stream","event_kind","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_evidence_keys_cohort_kek_uq" ON "stripe_evidence_keys" USING btree ("cohort","kek_version");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_provider_event_conflicts_idem_uq" ON "stripe_provider_event_conflicts" USING btree ("event_record_id","conflict_kind","conflicting_sha256");--> statement-breakpoint
CREATE INDEX "stripe_provider_event_dispositions_event_seq_idx" ON "stripe_provider_event_dispositions" USING btree ("event_record_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_provider_event_dispositions_claim_uq" ON "stripe_provider_event_dispositions" USING btree ("event_record_id","attempt_no") WHERE "stripe_provider_event_dispositions"."disposition" = 'processing_claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_provider_events_identity_uq" ON "stripe_provider_events" USING btree ("receiving_account_id","event_account_id","livemode","stripe_event_id","provenance");--> statement-breakpoint
CREATE INDEX "stripe_provider_events_subscription_created_idx" ON "stripe_provider_events" USING btree ("stripe_subscription_id","provider_created_at");--> statement-breakpoint
CREATE INDEX "stripe_provider_events_received_at_idx" ON "stripe_provider_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "stripe_provider_events_customer_idx" ON "stripe_provider_events" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_provider_malformed_receipts_digest_uq" ON "stripe_provider_malformed_receipts" USING btree ("payload_sha256");--> statement-breakpoint
CREATE INDEX "stripe_provider_malformed_receipts_received_at_idx" ON "stripe_provider_malformed_receipts" USING btree ("received_at");--> statement-breakpoint
-- HETA-01-F1 append-only protection (hand-appended, 0043 precedent). Tamper-evident, not tamper-proof:
-- an owner can DISABLE TRIGGER, as with the 0041/0042/0044 guards and 0043.
CREATE OR REPLACE FUNCTION stripe_provider_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Stripe provider evidence tables are append-only (% on %)', TG_OP, TG_TABLE_NAME; END;
$$;
--> statement-breakpoint
CREATE TRIGGER stripe_evidence_control_events_no_update_delete BEFORE UPDATE OR DELETE ON stripe_evidence_control_events FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_evidence_control_events_no_truncate BEFORE TRUNCATE ON stripe_evidence_control_events FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_evidence_keys_no_update_delete BEFORE UPDATE OR DELETE ON stripe_evidence_keys FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_evidence_keys_no_truncate BEFORE TRUNCATE ON stripe_evidence_keys FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_events_no_update_delete BEFORE UPDATE OR DELETE ON stripe_provider_events FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_events_no_truncate BEFORE TRUNCATE ON stripe_provider_events FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_malformed_receipts_no_update_delete BEFORE UPDATE OR DELETE ON stripe_provider_malformed_receipts FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_malformed_receipts_no_truncate BEFORE TRUNCATE ON stripe_provider_malformed_receipts FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_event_dispositions_no_update_delete BEFORE UPDATE OR DELETE ON stripe_provider_event_dispositions FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_event_dispositions_no_truncate BEFORE TRUNCATE ON stripe_provider_event_dispositions FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_event_conflicts_no_update_delete BEFORE UPDATE OR DELETE ON stripe_provider_event_conflicts FOR EACH ROW EXECUTE FUNCTION stripe_provider_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER stripe_provider_event_conflicts_no_truncate BEFORE TRUNCATE ON stripe_provider_event_conflicts FOR EACH STATEMENT EXECUTE FUNCTION stripe_provider_evidence_immutable();