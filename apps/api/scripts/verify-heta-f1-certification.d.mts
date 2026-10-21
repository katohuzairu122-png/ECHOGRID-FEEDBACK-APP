export const CERT_DB_PATTERN: RegExp;
export const FORBIDDEN_DATABASES: string[];
export const GUARD_TRIGGERS: string[];
export const GUARD_CONSTRAINTS: string[];
export const LOCAL_TEST_ACK: string;
export function checkTarget(urlString: string | undefined, expected: { host?: string; database?: string }, opts?: { localTest?: boolean }): string[];
export interface JournalEntry { tag: string; when: number; sha256: string }
export interface CatalogEntry { columns: string[]; checks: string[]; uniques: string[]; foreignKeys: string[]; indexes: string[]; triggers: string[] }
export interface Contract { tables: Record<string, CatalogEntry> }
export function evaluateCertification(input: {
  journal: JournalEntry[];
  applied: { hash: string; createdAt: string | number }[];
  triggers: { tgname: string; tgenabled: string }[];
  constraints: { conname: string; convalidated: boolean }[];
  catalog: Record<string, CatalogEntry>;
  contract: Contract;
}): { ok: boolean; failures: string[] };
export function readJournal(apiDir?: string): JournalEntry[];
export function readContract(): Contract;
