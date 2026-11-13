-- Gate 2 B4-11 (DISPOSABLE POSTGRESQL 18 ONLY, NOT A MIGRATION): a restricted nonowner broker login whose ONLY capability is one fixed, use-time-authorized operation.
-- Executed only by scripts/gate2-b4-11-disposable-restricted-broker-role.mjs inside a CI-created database after the 70 committed migrations were replayed. Never applied to Neon, staging or production.
--
-- Trust model (B4-07 decision): PostgreSQL cannot verify the Ed25519 assertion, so the isolated broker SERVICE verifies it and then connects as the broker login. The database therefore trusts the LOGIN (whose credential only
-- that service holds) for "a verified request was made", and trusts NOTHING else the caller says: the routine re-derives authorization from persisted state at USE TIME (live exact session, active actor/business, branch ownership,
-- tenant-matching role grant carrying branches:view), consumes the single-use nonce atomically, and returns two columns. The broker login has no table, sequence or schema privilege at all.

CREATE SCHEMA gate2_b411;
REVOKE ALL ON SCHEMA gate2_b411 FROM PUBLIC;

-- The routine owner is a NOLOGIN role with the minimum the routine needs. SELECT ... FOR SHARE (the lock that serializes use-time authorization against revocation writers) requires UPDATE privilege on at least
-- one column of each locked table, so each gets column-level UPDATE on ONE low-impact column; the owner has no INSERT/DELETE/TRUNCATE on any application table and no other UPDATE.
CREATE ROLE gate2_b411_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gate2_b411_owner;
GRANT SELECT, UPDATE (updated_by) ON public.users, public.businesses, public.branches, public.roles TO gate2_b411_owner;
GRANT SELECT, UPDATE (user_agent) ON public.refresh_tokens TO gate2_b411_owner;
GRANT SELECT, UPDATE (created_by) ON public.user_business_roles TO gate2_b411_owner;
GRANT SELECT, UPDATE (created_at) ON public.role_permissions TO gate2_b411_owner;
GRANT SELECT, UPDATE (updated_at) ON public.permissions TO gate2_b411_owner;

CREATE TABLE gate2_b411.nonces (
  nonce uuid PRIMARY KEY, actor uuid NOT NULL, session_id uuid NOT NULL, business uuid NOT NULL, branch uuid NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX nonces_expiry_idx ON gate2_b411.nonces (expires_at);
ALTER TABLE gate2_b411.nonces OWNER TO gate2_b411_owner;
REVOKE ALL ON TABLE gate2_b411.nonces FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA gate2_b411 TO gate2_b411_owner;

SET ROLE gate2_b411_owner;
-- Returns exactly one row. outcome: OK | REPLAYED | DENIED_ACTOR | DENIED_SESSION | DENIED_BUSINESS | DENIED_BRANCH | DENIED_GRANT. The broker service maps every DENIED_* and REPLAYED to one generic denial.
-- Malformed or expired/over-wide requests RAISE (nothing is consumed, so a retry after a transient failure is possible); once the nonce is consumed every outcome is RETURNED so the consumption commits.
CREATE FUNCTION gate2_b411.branch_read(p_actor uuid, p_session uuid, p_business uuid, p_branch uuid, p_nonce uuid, p_exp_ms bigint)
RETURNS TABLE (outcome text, branch_id uuid, branch_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '3s'
AS $fn$
DECLARE
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_name text; n integer;
BEGIN
  -- defense in depth beside the EXECUTE grant: only the broker login may use this routine, whatever roles it could reach
  IF session_user <> 'gate2_b411_broker' THEN RAISE EXCEPTION 'GATE2_B411_CALLER_NOT_BROKER' USING ERRCODE = '42501'; END IF;
  IF p_actor IS NULL OR p_session IS NULL OR p_business IS NULL OR p_branch IS NULL OR p_nonce IS NULL OR p_exp_ms IS NULL THEN RAISE EXCEPTION 'GATE2_B411_MALFORMED' USING ERRCODE = '22023'; END IF;
  IF p_exp_ms <= now_ms THEN RAISE EXCEPTION 'GATE2_B411_EXPIRED' USING ERRCODE = '22023'; END IF;
  IF p_exp_ms - now_ms > 120000 THEN RAISE EXCEPTION 'GATE2_B411_WINDOW' USING ERRCODE = '22023'; END IF;

  -- one attempt per nonce, whatever the outcome; expired registry rows are removed here, so the table stays bounded without a job
  DELETE FROM gate2_b411.nonces WHERE expires_at < clock_timestamp() - interval '10 minutes';
  INSERT INTO gate2_b411.nonces(nonce, actor, session_id, business, branch, expires_at) VALUES (p_nonce, p_actor, p_session, p_business, p_branch, to_timestamp(p_exp_ms / 1000.0)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN QUERY SELECT 'REPLAYED'::text, NULL::uuid, NULL::text; RETURN; END IF;

  -- use-time authorization in the SAME fixed lock order as the issuer: user, exact session rows, business, branch, grant chain. FOR SHARE makes a concurrent revocation either finish first (and be seen here:
  -- the locking SELECT re-evaluates its conditions on the new row version) or wait until this transaction ends.
  PERFORM 1 FROM public.users u WHERE u.id = p_actor AND u.status = 'active' AND NOT u.is_deleted AND u.deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'DENIED_ACTOR'::text, NULL::uuid, NULL::text; RETURN; END IF;
  PERFORM 1 FROM public.refresh_tokens t WHERE t.user_id = p_actor AND t.session_id = p_session AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'DENIED_SESSION'::text, NULL::uuid, NULL::text; RETURN; END IF;
  PERFORM 1 FROM public.businesses b WHERE b.id = p_business AND b.status = 'active' AND NOT b.is_deleted AND b.deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'DENIED_BUSINESS'::text, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT b.name INTO v_name FROM public.branches b WHERE b.id = p_branch AND b.business_id = p_business AND NOT b.is_deleted FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'DENIED_BRANCH'::text, NULL::uuid, NULL::text; RETURN; END IF;
  -- the permission-bearing chain, tenant-matched at every link: the role must belong to the SAME business as the grant (an injected cross-tenant role reference grants nothing)
  PERFORM 1 FROM public.user_business_roles g JOIN public.roles r ON r.id = g.role_id JOIN public.role_permissions rp ON rp.role_id = r.id JOIN public.permissions p ON p.id = rp.permission_id
    WHERE g.user_id = p_actor AND g.business_id = p_business AND r.business_id = g.business_id AND (g.branch_id IS NULL OR g.branch_id = p_branch)
      AND g.deleted_at IS NULL AND NOT r.is_deleted AND p.key = 'branches:view' ORDER BY g.id FOR SHARE OF g, r, rp, p;
  IF NOT FOUND THEN RETURN QUERY SELECT 'DENIED_GRANT'::text, NULL::uuid, NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'OK'::text, p_branch, v_name;
END $fn$;
RESET ROLE;

REVOKE ALL ON FUNCTION gate2_b411.branch_read(uuid, uuid, uuid, uuid, uuid, bigint) FROM PUBLIC;
REVOKE CREATE ON SCHEMA gate2_b411 FROM gate2_b411_owner;
