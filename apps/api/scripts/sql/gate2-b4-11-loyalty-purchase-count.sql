-- Disposable B4-11 only. Expose a branch count, with no customer or amount projection.
GRANT SELECT (business_id, branch_id, payment_status) ON public.loyalty_purchase_events TO gate2_b411_owner;
GRANT CREATE ON SCHEMA gate2_b411 TO gate2_b411_owner;

SET ROLE gate2_b411_owner;
CREATE FUNCTION gate2_b411.confirmed_purchase_count(p_actor uuid, p_session uuid, p_business uuid, p_branch uuid, p_nonce uuid, p_exp_ms bigint)
RETURNS TABLE (outcome text, purchase_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '3s'
AS $fn$
DECLARE
  v_outcome text;
BEGIN
  SELECT r.outcome INTO v_outcome FROM gate2_b411.branch_read(p_actor, p_session, p_business, p_branch, p_nonce, p_exp_ms) r;
  IF v_outcome IS DISTINCT FROM 'OK' THEN
    RETURN QUERY SELECT v_outcome, NULL::integer;
    RETURN;
  END IF;
  PERFORM 1 FROM public.user_business_roles g
    JOIN public.roles r ON r.id = g.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE g.user_id = p_actor AND g.business_id = p_business AND r.business_id = g.business_id
      AND (g.branch_id IS NULL OR g.branch_id = p_branch)
      AND g.deleted_at IS NULL AND NOT r.is_deleted AND p.key = 'loyalty:serve'
    ORDER BY g.id FOR SHARE OF g, r, rp, p;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'DENIED_GRANT'::text, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'OK'::text, count(*)::integer
    FROM public.loyalty_purchase_events e
    WHERE e.business_id = p_business AND e.branch_id = p_branch AND e.payment_status = 'confirmed';
END $fn$;
RESET ROLE;

REVOKE ALL ON FUNCTION gate2_b411.confirmed_purchase_count(uuid, uuid, uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gate2_b411.confirmed_purchase_count(uuid, uuid, uuid, uuid, uuid, bigint) TO gate2_b411_broker;
REVOKE CREATE ON SCHEMA gate2_b411 FROM gate2_b411_owner;
