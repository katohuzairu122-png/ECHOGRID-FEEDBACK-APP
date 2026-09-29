#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drizzleRoot = path.join(apiRoot, 'drizzle');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  process.stderr.write('[production-migrations] DATABASE_URL is required.\n');
  process.exit(1);
}

const journal = JSON.parse(
  fs.readFileSync(path.join(drizzleRoot, 'meta', '_journal.json'), 'utf8'),
);
const expected = journal.entries.map((entry) => {
  const file = `${entry.tag}.sql`;
  const sql = fs.readFileSync(path.join(drizzleRoot, file), 'utf8');
  return {
    file,
    hash: createHash('sha256').update(sql).digest('hex'),
  };
});

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const table = await client.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`,
  );
  if (!table.rows[0]?.name) {
    throw new Error('drizzle.__drizzle_migrations does not exist; no production migrations are recorded.');
  }

  const applied = await client.query(
    `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  const appliedHashes = new Set(applied.rows.map((row) => row.hash));
  const pending = expected.filter((migration) => !appliedHashes.has(migration.hash));

  if (pending.length > 0) {
    process.stderr.write(
      `[production-migrations] ${pending.length} pending migration(s):\n${pending
        .map((migration) => `  ${migration.file}`)
        .join('\n')}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[production-migrations] OK -- ${expected.length} repository migration(s) are applied.\n`,
  );
} finally {
  await client.end().catch(() => undefined);
}
