import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client';
import type { LoadedKeyring } from './keyring';
const append = vi.hoisted(() => vi.fn());
vi.mock('./control-events', () => ({ ControlEventWriter: class { append = append; } }));
import { ForensicReader } from './forensic';
const ctx = { actor: 'test-custodian', reason: 'synthetic drill' };
function fixture() {
  const files = { write: vi.fn(), destroy: vi.fn() };
  const reader = new ForensicReader({} as Database, {} as LoadedKeyring, files);
  const plaintext = new Uint8Array([17, 29, 43]);
  const read = vi.spyOn(reader, 'readEvent').mockResolvedValue(plaintext);
  return { files, reader, plaintext, read };
}
beforeEach(() => { append.mockReset(); append.mockResolvedValue(undefined); });
describe('forensic secure output boundary', () => {
  it('reads, registers, then writes exact bytes and wipes the export buffer', async () => {
    const f = fixture(); const order: string[] = [];
    f.read.mockImplementation(async () => { order.push('audited-read'); return f.plaintext; });
    append.mockImplementation(async () => { order.push('registered'); });
    f.files.write.mockImplementation(async () => { order.push('write'); expect([...f.plaintext]).toEqual([17, 29, 43]); });
    const result = await f.reader.exportEventToFile('event', ctx, '/private/export', 'custodian');
    expect(order).toEqual(['audited-read', 'registered', 'write']); expect(result.exportLabel).toBeTruthy();
    expect([...f.plaintext]).toEqual([0, 0, 0]); expect(JSON.stringify(append.mock.calls)).not.toContain('/private');
  });
  it('registration failure prevents output and wipes plaintext', async () => {
    const f = fixture(); append.mockRejectedValue(new Error('synthetic failure'));
    await expect(f.reader.exportEventToFile('event', ctx, '/private/export', 'custodian')).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    expect(f.files.write).not.toHaveBeenCalled(); expect([...f.plaintext]).toEqual([0, 0, 0]);
  });
  it('write and cleanup failures are preserved and no success is reported', async () => {
    const f = fixture(); const error = Object.assign(new Error('WRITE'), { code: 'WRITE', cleanupError: { code: 'CLEANUP' } });
    f.files.write.mockRejectedValue(error);
    await expect(f.reader.exportEventToFile('event', ctx, '/private/export', 'custodian')).rejects.toBe(error);
    expect([...f.plaintext]).toEqual([0, 0, 0]); expect(append).toHaveBeenCalledTimes(1);
  });
  it('existing destination errors preserve the public refusal contract', async () => {
    const f = fixture(); f.files.write.mockRejectedValue({ code: 'EXISTS' });
    await expect(f.reader.exportEventToFile('event', ctx, '/private/export', 'custodian')).rejects.toMatchObject({ code: 'EXPORT_EXISTS' });
  });
  it('destruction audit follows successful verified removal', async () => {
    const f = fixture(); const order: string[] = [];
    f.files.destroy.mockImplementation(async () => { order.push('destroy'); }); append.mockImplementation(async () => { order.push('audit'); });
    await f.reader.destroyExport('/private/export', 'label', ctx);
    expect(order).toEqual(['destroy', 'audit']); expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'forensic_export_destroyed', dedupeKey: 'fexd:label' }));
  });
  it('audit failure after removal is reported without claiming audit success', async () => {
    const f = fixture(); const error = new Error('synthetic audit failure'); append.mockRejectedValue(error);
    await expect(f.reader.destroyExport('/private/export', 'label', ctx)).rejects.toBe(error);
    expect(f.files.destroy).toHaveBeenCalledTimes(1); expect(append).toHaveBeenCalledTimes(1);
  });
  it('failed destruction never emits a successful destruction record', async () => {
    const f = fixture(); f.files.destroy.mockRejectedValue({ code: 'IDENTITY' });
    await expect(f.reader.destroyExport('/private/export', 'label', ctx)).rejects.toMatchObject({ code: 'IDENTITY' }); expect(append).not.toHaveBeenCalled();
  });
  it('missing exports retain the public error contract', async () => {
    const f = fixture(); f.files.destroy.mockRejectedValue({ code: 'MISSING' });
    await expect(f.reader.destroyExport('/private/export', 'label', ctx)).rejects.toMatchObject({ code: 'EXPORT_MISSING' }); expect(append).not.toHaveBeenCalled();
  });
  it('no operator adapter means no filesystem fallback or decryption', async () => {
    const reader = new ForensicReader({} as Database, {} as LoadedKeyring);
    await expect(reader.exportEventToFile('event', ctx, '/private/export', 'custodian')).rejects.toMatchObject({ code: 'SECURE_OUTPUT_UNAVAILABLE' });
    await expect(reader.destroyExport('/private/export', 'label', ctx)).rejects.toMatchObject({ code: 'SECURE_OUTPUT_UNAVAILABLE' }); expect(append).not.toHaveBeenCalled();
  });
  it('invalid destruction context is rejected before native operations', async () => {
    const f = fixture(); await expect(f.reader.destroyExport('/private/export', 'label', { actor: '', reason: 'x' })).rejects.toMatchObject({ code: 'BAD_AUDIT_CONTEXT' }); expect(f.files.destroy).not.toHaveBeenCalled();
  });
});
