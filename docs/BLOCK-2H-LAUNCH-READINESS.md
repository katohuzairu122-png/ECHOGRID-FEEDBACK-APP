# Block 2H — Final Launch Readiness

Block 2H consolidates the verified release chain into a commit-bound technical release decision.

```bash
pnpm block18:preflight
pnpm block18:audit
pnpm block18:verify:static
BLOCK18_API_URL=https://api.example.com BLOCK18_WEB_URL=https://app.example.com pnpm block18:verify
BLOCK18_RELEASE_VERSION=v0.1.0-rc.1 BLOCK18_GIT_COMMIT=<40-character-sha> pnpm block18:evidence
```

CI collects evidence from Blocks 2D–2G, probes both deployed Workers, and creates `release-attestation.json` containing SHA-256 hashes, the release version, and exact commit. This grants Technical GO; public paid launch remains a separate owner decision.
