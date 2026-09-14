import type { Bindings } from '../../src/config/env';

/**
 * Tells TypeScript what `env` from 'cloudflare:test' actually contains.
 *
 * @cloudflare/vitest-pool-workers declares `ProvidedEnv` as an empty
 * interface for projects to augment. Without this augmentation, `env` is
 * typed as that empty interface, so every `worker.fetch(request, env, ctx)`
 * in test/workers is a type error the moment anything typechecks these files
 * -- which nothing did until tsconfig.test.json (audit P3-6).
 *
 * Pointing it at the real Bindings is also what makes the Workers suites
 * useful as a contract check: adding a binding to config/env.ts without
 * adding it to wrangler.toml now shows up here rather than at runtime.
 */
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Bindings {}
}
