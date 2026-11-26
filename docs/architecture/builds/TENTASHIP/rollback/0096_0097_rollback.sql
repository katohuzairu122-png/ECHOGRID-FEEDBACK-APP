-- ROLLBACK EVIDENCE for migrations 0096 (customer_invitations) and 0097 (qualification + referrals). NOT EXECUTED against any shared database.
-- Run only on Owner instruction, in a transaction, after a restore point exists. Both migrations are additive: new tables, functions and ONE new
-- partial unique index on customer_onboarding_events; no existing row, column or constraint is changed. This removes exactly those objects.
-- It DESTROYS invitations, referral attributions/events, qualification rule versions and consumptions recorded since the upgrade: back up first.
-- Afterwards delete the two newest drizzle ledger rows so a later upgrade re-applies them.
BEGIN;
DROP TABLE IF EXISTS customer_referral_events;
DROP TABLE IF EXISTS customer_referrals;
DROP TABLE IF EXISTS qualification_evidence_consumptions;
DROP TABLE IF EXISTS qualification_rule_versions;
DROP FUNCTION IF EXISTS customer_referral_events_guard();
DROP FUNCTION IF EXISTS qualification_rule_versions_guard();
DROP FUNCTION IF EXISTS qualification_append_only();
DROP TABLE IF EXISTS customer_invitations;
DROP FUNCTION IF EXISTS customer_invitations_guard();
DROP INDEX IF EXISTS customer_onboarding_events_remote_invite_once_key;
COMMIT;
