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
    createdAt: Number(entry.when),
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
    `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  const appliedByCreatedAt = new Map(
    applied.rows.map((row) => [Number(row.created_at), row.hash]),
  );
  const pending = expected.filter(
    (migration) => !appliedByCreatedAt.has(migration.createdAt),
  );

  if (pending.length > 0) {
    process.stderr.write(
      `[production-migrations] ${pending.length} pending migration(s):\n${pending
        .map((migration) => `  ${migration.file}`)
        .join('\n')}\n`,
    );
    process.exit(1);
  }

  // Drizzle identifies whether a migration is pending by the journal's
  // `when` value (`created_at` in the database), not by re-hashing every
  // historical SQL file. Older Echo Grid migrations were normalized after
  // they had already been applied, so their stored hashes legitimately
  // differ while their immutable journal identities remain present.
  const matchingHashes = expected.filter(
    (migration) => appliedByCreatedAt.get(migration.createdAt) === migration.hash,
  ).length;

  process.stdout.write(
    `[production-migrations] OK -- ${expected.length} repository migration(s) are applied (${matchingHashes} exact SQL hash match(es)).\n`,
  );
} finally {
  await client.end().catch(() => undefined);
}
