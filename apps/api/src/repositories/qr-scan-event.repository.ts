import { qrScanEvents } from '../db/schema';
import { BaseRepository } from './base.repository';

export type QrScanEvent = typeof qrScanEvents.$inferSelect;
export type NewQrScanEvent = typeof qrScanEvents.$inferInsert;

export class QrScanEventRepository extends BaseRepository {
  async recordDeduplicated(input: NewQrScanEvent): Promise<{ event: QrScanEvent | null; recorded: boolean }> {
    const [event] = await this.db
      .insert(qrScanEvents)
      .values(input)
      .onConflictDoNothing({
        target: [qrScanEvents.qrCodeId, qrScanEvents.clientHash, qrScanEvents.dedupBucket],
      })
      .returning();
    return { event: event ?? null, recorded: event !== undefined };
  }
}

