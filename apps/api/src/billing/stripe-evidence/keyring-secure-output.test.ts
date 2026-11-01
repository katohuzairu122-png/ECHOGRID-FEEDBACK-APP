import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeKeyringSecret, safeOutputError } from '../../../scripts/stripe-evidence/_secure-output';

const native = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@echo-grid-feedback/secure-file', () => ({ writeSecretFileExclusive: native.write }));
const dirs: string[] = [];
function path() { const d = mkdtempSync(join(tmpdir(), 'sf-keyring-unit-')); dirs.push(d); chmodSync(d, 0o700); return join(d, 'entry.json'); }
afterEach(() => { vi.clearAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('operator secret output adapter (mocked native boundary)', () => {
  it('passes exact bytes and wipes its temporary buffer after success', async () => {
    let copy = '', original: Uint8Array | undefined;
    native.write.mockImplementation((_p: string, b: Uint8Array) => { original = b; copy = Buffer.from(b).toString(); });
    const result = await writeKeyringSecret(path(), 'synthetic-secret');
    expect(copy).toBe('synthetic-secret'); expect(original?.every(b => b === 0)).toBe(true);
    expect(result).toEqual(process.platform === 'win32' ? { protection: 'protected-owner-only-dacl' } : { protection: 'owner-only-posix', mode: '0600' });
  });
  it('preserves the native error and cleanup outcome, wiping bytes on failure', async () => {
    let original: Uint8Array | undefined;
    const error = Object.assign(new Error('synthetic-private-message'), { code: 'WRITE', cleanupError: { code: 'CLEANUP', osError: 5 } });
    native.write.mockImplementation((_p: string, b: Uint8Array) => { original = b; throw error; });
    await expect(writeKeyringSecret(path(), 'synthetic-secret')).rejects.toBe(error);
    expect(original?.every(b => b === 0)).toBe(true);
    expect(safeOutputError(error)).toEqual({ code: 'WRITE', cleanupCode: 'CLEANUP' });
  });
  it('rejects a relative destination before invoking native code', async () => {
    await expect(writeKeyringSecret('relative.json', 'synthetic')).rejects.toMatchObject({ code: 'PATH' });
    expect(native.write).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'linux')('requires an owned 0700 immediate Linux directory', async () => {
    const p = path(); chmodSync(dirs[0]!, 0o777);
    await expect(writeKeyringSecret(p, 'synthetic')).rejects.toMatchObject({ code: 'UNSAFE_PARENT' });
    expect(native.write).not.toHaveBeenCalled();
  });
  it('sanitizes unknown exception text, values and codes', () => {
    for (const e of [new Error('secret'), 'secret', null, { code: 'secret', cleanupError: { code: 'secret' } }]) expect(safeOutputError(e)).toEqual({ code: 'OPERATION_FAILED' });
  });
});
