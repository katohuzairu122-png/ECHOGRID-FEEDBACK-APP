# Block 2F — Deployment and Operations

Block 2F turns Block 16's prepared deployment controls into enforced CI release gates.

## Commands

```bash
pnpm block16:preflight
pnpm block16:env:audit
pnpm block16:manifest
BLOCK16_API_URL=https://api.example.com BLOCK16_WEB_URL=https://app.example.com pnpm block16:smoke
pnpm block16:verify
pnpm block16:evidence
```

The environment audit rejects placeholder or insecure production configuration and verifies the required production and staging Worker bindings. The manifest records SHA-256 hashes for the lockfile, workspace definition, package scripts, both Worker configurations, and the deployment workflow.

After API and web deployment, CI probes the production API health endpoint, the web root, and the login route. It combines those results with the pre-deployment audit and manifest, then uploads `block-2f-release-evidence`.

Rollback remains an operator action because selecting a prior Cloudflare version changes live traffic. [DEPLOYMENT.md](./DEPLOYMENT.md#rollback) contains explicit API-first and web-second commands. Database changes use a reviewed forward migration or manual repair because this repository has no automated down migrations.
