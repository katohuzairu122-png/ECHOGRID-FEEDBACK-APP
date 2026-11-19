import type { Env } from '../src/config';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
