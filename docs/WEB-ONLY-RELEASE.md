# Web-only production release amendment — proposed for review

The existing production workflow deploys the API before the Web Worker. This separate manual workflow supports a reviewed Web-only repair without dispatching that paired release or changing the API.

## Gates

1. Dispatch from main with its exact current 40-character SHA and `DEPLOY_PRODUCTION_WEB_ONLY`.
2. Read GitHub's production environment metadata. Missing required reviewers, allowed self-review, unrestricted branches or an unreadable configuration fail closed. The phrase is not approval.
3. Run the entire existing CI workflow in this release run, then build OpenNext and smoke its local Worker preview. The preview API override is loopback port 1, so anonymous smoke requests cannot reach production APIs.
4. Seal the resulting `.open-next` directory in a SHA-256-checked, same-run immutable artifact.
5. Require the existing protected `production` environment approval. Recheck that main has not advanced, restore the tested artifact and install the pinned lockfile without rebuilding.
6. Before deployment, verify the known production account, exact existing Worker UUID and domain mapping. Reject resource bindings or cache overrides that could create ancillary infrastructure.
7. Deploy only `echo-grid-feedback-web` using pinned Wrangler with an explicit top-level environment and the sealed OpenNext bundle. This avoids rebuilding or running cache tooling during deployment. Independently read back the 100% deployed version, check the homepage and login HTTP 200, and compare the API deployment fingerprint before/after. Record non-secret provenance.

## Verified target identity

- Account `cf205213947e3617297373060fe4c15f`.
- Worker `echo-grid-feedback-web`, resource `83591b02fdb84691b1c81a1699f4bba4`.
- Existing domain `echo-grid.uk` maps to this Worker.
- These identities were read through authenticated provider APIs during amendment preparation. No infrastructure was modified.

## Review and release boundary

This amendment is not approval to merge or dispatch itself. Production protection metadata could not be inspected with the current GitHub connector; configured reviewers and successful enforcement are not claimed. The workflow explicitly checks those settings at dispatch and refuses an unprotected release. Owner review, integration into main and the protected environment approval remain required before deployment.

Before authorizing a release, the owner must confirm that `production` allows deployment from `main` only and that Cloudflare credentials are scoped to the environment, with no repository-level copies. Workflow checks cannot prove secret placement.

The existing API-first release workflow, all API/database/migration code, Stripe configuration and financial activation remain untouched. No secrets are created or printed. No database commands or migrations run in the Web deployment jobs; the required existing CI uses disposable databases as before. A failed post-deployment check does not authorize API changes or an automatic rollback.

Validation: `node --test tools/web-only-release.test.mjs` covers exact-head, branch, confirmation, approval configuration, target/resource restrictions, unchanged-API and final-Web-version denials. The dedicated PR validation workflow runs these checks without deployment credentials or a production environment.

References: [GitHub environment read API](https://docs.github.com/en/rest/deployments/environments#get-an-environment), [OpenNext build/preview/deploy commands](https://opennext.js.org/cloudflare/cli).
