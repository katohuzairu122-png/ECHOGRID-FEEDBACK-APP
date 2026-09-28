import { z } from 'zod';

/** Opaque, client-generated signal. It is salted and hashed before storage. */
export const recordQrScanSchema = z.object({
  deviceSignal: z.string().trim().min(1).max(256),
});

export type RecordQrScanInput = z.infer<typeof recordQrScanSchema>;

