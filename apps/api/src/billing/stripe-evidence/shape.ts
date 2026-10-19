/**
 * HETA-01-F1 A.2b / G.1: shape classification of an AUTHENTICATED body, separate from signature verification.
 * A body that fails here is never an invalid signature; it becomes a malformed receipt (quarantine QR_SHAPE_INVALID).
 */
export const SHAPE_DEFECTS = [
  'missing_id', 'bad_id', 'missing_created', 'bad_created', 'missing_livemode', 'bad_livemode',
  'missing_type', 'bad_type', 'missing_data_object', 'bad_data_object',
] as const;
export type ShapeDefect = (typeof SHAPE_DEFECTS)[number];
export type ParseStatus = 'not_json' | 'json_non_object' | 'json_object_invalid_envelope';

export interface WellFormedEnvelope {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  /** Present only for Connect-style events; validated by the caller against the account pattern. */
  account: string | null;
  apiVersion: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  dataObject: Record<string, unknown>;
}

export type ShapeResult =
  | { kind: 'ok'; envelope: WellFormedEnvelope }
  | { kind: 'malformed'; parseStatus: ParseStatus; defects: ShapeDefect[] };

const MISSING_ALL: ShapeDefect[] = ['missing_id', 'missing_created', 'missing_livemode', 'missing_type', 'missing_data_object'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function classifyEnvelope(rawBody: string): ShapeResult {
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch {
    return { kind: 'malformed', parseStatus: 'not_json', defects: [...MISSING_ALL] };
  }
  if (!isObj(doc)) return { kind: 'malformed', parseStatus: 'json_non_object', defects: [...MISSING_ALL] };

  const defects: ShapeDefect[] = [];
  const id = doc.id;
  if (id === undefined) defects.push('missing_id');
  else if (typeof id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(id)) defects.push('bad_id');
  const created = doc.created;
  if (created === undefined) defects.push('missing_created');
  else if (typeof created !== 'number' || !Number.isSafeInteger(created) || created <= 0) defects.push('bad_created');
  const livemode = doc.livemode;
  if (livemode === undefined) defects.push('missing_livemode');
  else if (typeof livemode !== 'boolean') defects.push('bad_livemode');
  const type = doc.type;
  if (type === undefined) defects.push('missing_type');
  else if (typeof type !== 'string' || type === '') defects.push('bad_type');
  const data = doc.data;
  if (!isObj(data) || data.object === undefined) defects.push('missing_data_object');
  else if (!isObj(data.object)) defects.push('bad_data_object');
  if (defects.length > 0) return { kind: 'malformed', parseStatus: 'json_object_invalid_envelope', defects };

  const request = isObj(doc.request) ? doc.request : {};
  return {
    kind: 'ok',
    envelope: {
      id: id as string,
      type: type as string,
      created: created as number,
      livemode: livemode as boolean,
      account: str(doc.account),
      apiVersion: str(doc.api_version),
      requestId: str(request.id),
      idempotencyKey: str(request.idempotency_key),
      dataObject: (data as { object: Record<string, unknown> }).object,
    },
  };
}
