# Split 07 Block 2 — Implementation Slice A: Evidence Revalidation
**Development authorized:** Block 1 completion lock merged on main.
**Scope:** Internal read-only verification of Split 06 completion evidence against locked settlement, settled claim, canonical fulfillment event, business identity and absence of reversals.
**Economic state:** NOT ACTIVATED; migration 0041 continues to forbid award decisions, ledger inserts, lots and account projection changes.
**Security:** External evidence is merely a locator. Do not trust client-provided fulfillment history.
**Review gate:** No credit issuance in this PR. Before proceeding add positive and negative real-Postgres evidence tests; verify source event invariants with Split 06 code, including reversal races and >200-event histories. Block 2 must implement explicit enrollment, account locking, UTC-month cap, policy immutability and atomic provisional award in separate reviewed follow-up. Ensure candidate passes CI.
