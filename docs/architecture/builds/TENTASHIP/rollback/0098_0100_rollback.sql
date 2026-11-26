-- ROLLBACK EVIDENCE for migrations 0098 (shuffle_campaigns), 0099 (shuffle_participation) and 0100 (drops_sponsorship_inventory). NOT EXECUTED against
-- any shared database. Run only on Owner instruction, in a transaction, after a restore point exists. All three are additive (new tables and functions only;
-- no existing row, column or constraint is changed). This removes exactly those objects. It DESTROYS campaign configuration, eligibility snapshots,
-- synthetic invitations/entries/selection records, sponsorships, inventory, reservations and evidence chains: back up first.
-- Afterwards delete the three newest drizzle ledger rows (0098, 0099, 0100) so a later upgrade re-applies them.
BEGIN;
DROP TABLE IF EXISTS drop_events;
DROP TABLE IF EXISTS drop_reservations;
DROP TABLE IF EXISTS drop_inventory;
DROP TABLE IF EXISTS drop_sponsorship_versions;
DROP TABLE IF EXISTS drop_sponsorships;
DROP FUNCTION IF EXISTS drop_sponsorships_guard();
DROP FUNCTION IF EXISTS drop_versions_guard();
DROP FUNCTION IF EXISTS drop_inventory_guard();
DROP FUNCTION IF EXISTS drop_reservations_guard();
DROP FUNCTION IF EXISTS drop_events_chain();
DROP FUNCTION IF EXISTS drop_append_only();
DROP TABLE IF EXISTS shuffle_selection_results;
DROP TABLE IF EXISTS shuffle_allocation_events;
DROP TABLE IF EXISTS shuffle_entries;
DROP TABLE IF EXISTS shuffle_notification_intents;
DROP TABLE IF EXISTS shuffle_invitation_events;
DROP TABLE IF EXISTS shuffle_invitations;
DROP TABLE IF EXISTS shuffle_eligibility_snapshots;
DROP TABLE IF EXISTS shuffle_campaign_versions;
DROP TABLE IF EXISTS shuffle_campaigns;
DROP FUNCTION IF EXISTS shuffle_selection_results_guard();
DROP FUNCTION IF EXISTS shuffle_allocation_events_chain();
DROP FUNCTION IF EXISTS shuffle_entries_guard();
DROP FUNCTION IF EXISTS shuffle_invitations_guard();
DROP FUNCTION IF EXISTS shuffle_append_only();
DROP FUNCTION IF EXISTS shuffle_campaigns_guard();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3);  -- run after verifying the above
COMMIT;
