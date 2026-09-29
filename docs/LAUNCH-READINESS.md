# Launch Readiness Decision

## Technical GO

A commit is technically qualified only when its single CI run passes typecheck, lint, unit and integration tests, production builds, Playwright, security, bounded load, ordered deployment, operations, billing probes, and Block 2H attestation. The attestation sets `decision: TECHNICAL_GO`.

## Public launch authorization

Technical GO does not authorize a public paid launch. The INFINICUS LLC product owner must provide explicit written authorization after reviewing [PRODUCTION-CHECKLIST.md](./PRODUCTION-CHECKLIST.md), including legal policies, billing controls, backup/restore proof, monitoring, live Stripe configuration, and incident contacts.

## NO-GO conditions

A release is NO-GO if a required job fails or is skipped, evidence belongs to another commit, Critical or High security findings remain, a deployed Worker fails, migration state differs, billing boundaries regress, or the Stripe webhook accepts an unsigned payload.

## Rollback triggers

Rollback begins for sustained 5xx responses, authentication or tenant-isolation regression, data corruption, unsigned webhook acceptance, broken payment-state synchronization, queue failure risking data loss, or release-specific latency/error breaches. Follow [DEPLOYMENT.md](./DEPLOYMENT.md#rollback).
