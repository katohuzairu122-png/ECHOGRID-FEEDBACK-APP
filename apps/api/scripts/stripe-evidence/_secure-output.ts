import { Buffer } from 'node:buffer';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const FILE_CODES = new Set(['MISSING', 'ARGUMENT', 'PATH', 'SYMLINK', 'NOT_DIRECTORY', 'UNSAFE_PARENT', 'EXISTS', 'UNSUPPORTED', 'CREATE', 'VERIFY', 'IDENTITY', 'CLEANUP', 'STATE', 'WRITE', 'FLUSH', 'TOO_LARGE', 'INTERNAL']);
const failure = (code: string) => Object.assign(new Error(`secure output: ${code}`), { code });

/** Operator-only adapter. Never import into src/Worker barrels. No path canonicalization or fallback. */
function checkOutputPath(path: string): void {
  if (!isAbsolute(path)) throw failure('PATH');
  if (process.platform !== 'linux' && process.platform !== 'win32') throw failure('UNSUPPORTED');
  if (process.platform === 'linux') {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.geteuid?.() || (parent.mode & 0o7777) !== 0o700) throw failure('UNSAFE_PARENT');
  }
 }

/** Operator-only file adapter; never inject a pathname-based fallback. */
export const forensicFiles = {
  async write(path: string, bytes: Uint8Array): Promise<void> {
    checkOutputPath(path);
    const { writeSecretFileExclusive } = await import('@echo-grid-feedback/secure-file');
    writeSecretFileExclusive(path, bytes);
  },
  async destroy(path: string): Promise<void> {
    try { checkOutputPath(path); }
    catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') throw failure('MISSING');
      throw error;
    }
    const { destroySecretFile } = await import('@echo-grid-feedback/secure-file');
    destroySecretFile(path);
  },
};

export async function writeKeyringSecret(path: string, content: string): Promise<{ protection: string; mode?: string }> {
  checkOutputPath(path);
  // Loading failures are fatal; read-only commands need not load a native binary.
  const { writeSecretFileExclusive } = await import('@echo-grid-feedback/secure-file');
  const bytes = Buffer.from(content, 'utf8');
  try { writeSecretFileExclusive(path, bytes); }
  finally { bytes.fill(0); }
  return process.platform === 'win32'
    ? { protection: 'protected-owner-only-dacl' }
    : { protection: 'owner-only-posix', mode: '0600' };
}

/** Never echo arbitrary exception messages, malformed JSON, key bytes or native paths. */
export function safeOutputError(error: unknown): { code: string; cleanupCode?: string } {
  const e = error as { code?: unknown; cleanupError?: { code?: unknown } } | null;
  const code = typeof e?.code === 'string' && FILE_CODES.has(e.code) ? e.code : 'OPERATION_FAILED';
  const cleanup = e?.cleanupError?.code;
  return typeof cleanup === 'string' && FILE_CODES.has(cleanup) ? { code, cleanupCode: cleanup } : { code };
}
