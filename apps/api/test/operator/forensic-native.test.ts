import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from '../../src/db/client';
import type { LoadedKeyring } from '../../src/billing/stripe-evidence/keyring';
const append = vi.hoisted(() => vi.fn());
vi.mock('../../src/billing/stripe-evidence/control-events', () => ({ ControlEventWriter: class { append = append; } }));
import { ForensicReader } from '../../src/billing/stripe-evidence/forensic';
import { forensicFiles } from '../../scripts/stripe-evidence/_secure-output';
const dirs: string[] = [];
const ctx = { actor: 'synthetic-custodian', reason: 'native integration' };
function fixture() {
  append.mockReset(); append.mockResolvedValue(undefined);
  const dir = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'forensic-')); dirs.push(dir);
  const reader = new ForensicReader({} as Database, {} as LoadedKeyring, forensicFiles);
  vi.spyOn(reader, 'readEvent').mockImplementation(async () => new TextEncoder().encode('SYNTHETIC-EVIDENCE'));
  return { path: join(dir, 'export.bin'), reader };
}
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('forensic operator with actual native filesystem boundary', () => {
  it('exports exact synthetic plaintext then destroys and records removal', async () => {
    const f = fixture();
    const result = await f.reader.exportEventToFile('synthetic-event', ctx, f.path, 'synthetic-location');
    expect(readFileSync(f.path, 'utf8')).toBe('SYNTHETIC-EVIDENCE');
    await f.reader.destroyExport(f.path, result.exportLabel, ctx);
    expect(existsSync(f.path)).toBe(false);
    expect(append.mock.calls.map(c => c[0].kind)).toEqual(['forensic_export_registered', 'forensic_export_destroyed']);
  });
  it('never overwrites an existing exported file', async () => {
    const f = fixture(); await forensicFiles.write(f.path, new Uint8Array([17, 29]));
    await expect(f.reader.exportEventToFile('synthetic-event', ctx, f.path, 'synthetic-location')).rejects.toMatchObject({ code: 'EXPORT_EXISTS' });
    expect([...readFileSync(f.path)]).toEqual([17, 29]);
  });
  it('refuses hardlinked evidence without mutation or a destroyed audit', async () => {
    const f = fixture(); await forensicFiles.write(f.path, new Uint8Array([17, 29])); linkSync(f.path, f.path + '-alias');
    await expect(f.reader.destroyExport(f.path, 'label', ctx)).rejects.toMatchObject({ code: 'VERIFY' });
    expect([...readFileSync(f.path)]).toEqual([17, 29]); expect(append).not.toHaveBeenCalled();
  });
});
