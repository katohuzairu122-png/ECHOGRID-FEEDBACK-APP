# Block 2E — Security, Performance, and Reliability

Block 2E turns the repository's Block 15 hardening claims into executable checks and release evidence.

## Commands

```bash
pnpm block15:preflight
pnpm block15:security
BLOCK15_API_URL=https://api.example.com BLOCK15_WEB_URL=https://app.example.com pnpm block15:runtime
BLOCK15_API_URL=https://api.example.com BLOCK15_WEB_URL=https://app.example.com pnpm block15:load
pnpm block15:verify
pnpm block15:evidence
```

`block15:security` scans source and configuration for credential signatures and dynamic code execution, validates production TLS/CORS configuration, and fails on high or critical production dependency advisories.

`block15:runtime` requires explicit HTTPS targets. It verifies API health, root security headers, rejection of an untrusted CORS origin, and the web application's CSP, framing, transport, referrer, permissions, and MIME-sniffing policies.

`block15:load` sends a bounded health-probe workload. Defaults are 30 requests, concurrency 5, p95 at most 1500 ms, and error rate at most 2%. `BLOCK15_LOAD_REQUESTS`, `BLOCK15_LOAD_CONCURRENCY`, `BLOCK15_MAX_P95_MS`, and `BLOCK15_MAX_ERROR_RATE` override these limits.

Each command writes JSON under `.artifacts/block15/`. CI runs static checks before deployment, then runtime and load checks against the newly deployed Workers and uploads the evidence.

## Completion criteria

- Static security and production dependency checks pass.
- API and web runtime policies pass against HTTPS deployments.
- The bounded load smoke stays within latency and error thresholds.
- Typecheck, lint, unit, integration, build, and Block 2D E2E gates remain green.
- API and web deployment jobs pass before the runtime hardening job.
