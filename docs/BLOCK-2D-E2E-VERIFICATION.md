# Block 2D — End-to-End Verification

Block 2D verifies the application across real PostgreSQL transactions and a
real Chromium browser. CI provisions a disposable PostgreSQL 16 service,
applies every migration, seeds the permission catalog, starts the API and web
development Workers, and runs all Playwright flows. Production deployments
wait for this gate.

## Commands

| Command                  | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm block14:preflight` | Validate the database/remote target, local secrets, Playwright, Git, and required suites |
| `pnpm block14:e2e`       | Run the three browser flows locally or against explicit `E2E_BASE_URL`                   |
| `pnpm block14:verify`    | Run all API integration suites followed by Playwright                                    |
| `pnpm block14:evidence`  | Validate that successful verification evidence exists                                    |

Every command writes versioned JSON to `.artifacts/block14/`. CI uploads that
directory together with Playwright reports and failure traces.

Local verification refuses a non-local database unless
`BLOCK14_ALLOW_REMOTE_DATABASE=yes` is explicitly set. Remote browser runs
still pass through `e2e/base-url.ts`, which refuses production hosts without
the exact production-write acknowledgement.

## Verified paths

| Risk                   | Executable evidence                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation       | Integration suites cover cross-business feedback, permission resolution, redemption ownership, QR assignment, billing permissions, and branch uniqueness |
| Replay and abuse paths | Integration suites cover feedback idempotency, OTP lifecycle, QR scan deduplication, fraud filtering, and critical-incident atomicity                    |
| Browser/BFF lifecycle  | Playwright covers signup cookies, business and branch creation, QR scan through anonymous feedback to inbox, and loyalty configuration persistence       |
| Clean schema replay    | CI applies the complete migration chain to a new PostgreSQL 16 database before verification                                                              |
| Production safety      | E2E uses an ephemeral local database in CI; remote execution has no default target and guards production hosts                                           |

