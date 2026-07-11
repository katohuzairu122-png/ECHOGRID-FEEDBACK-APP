import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs as a plain Node CLI outside the Workers runtime, so it
 * connects directly to Postgres via DATABASE_URL (see .env.example) instead
 * of the Hyperdrive binding, which only exists inside a deployed/dev Worker.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
