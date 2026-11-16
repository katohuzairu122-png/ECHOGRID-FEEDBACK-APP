import { verifyB409Invocation, type B409Invocation } from '../auth/broker-workload-attestation';
import { validBrokerKey, type BrokerKeySource, type BrokerVerificationKey } from '../auth/broker-assertion.contract';
import { AppError } from '../lib/errors';

type Scope = Readonly<{ businessId: string; branchId: string }>;
type RestrictedConnection = {
  query(sql: string, args: (string | number)[]): Promise<{ rows: Array<{ outcome?: unknown; purchase_count?: unknown }> }>;
  release(destroy?: boolean): void;
};

const sql = 'SELECT outcome,purchase_count FROM gate2_b411.confirmed_purchase_count($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint)';
const forbidden = () => new AppError('Access denied.', 403, 'PERMISSION_DENIED');
const unavailable = () => new AppError('Service unavailable.', 503, 'BROKER_UNAVAILABLE');

/** Development composition only. The pool must belong exclusively to the restricted broker. */
export class ConfirmedPurchaseCountService {
  constructor(private readonly deps: Readonly<{
    assertionKeys: BrokerKeySource;
    workloadKeys: BrokerKeySource;
    connect(): Promise<RestrictedConnection>;
    now(): number;
  }>) {}

  async count(raw: unknown, requestedScope: Scope): Promise<number> {
    const { businessId, branchId } = requestedScope;
    const keys: BrokerVerificationKey[] = [];
    const capture = (source: BrokerKeySource): BrokerKeySource => async () => {
      const value = await source();
      const key = value ? { ...value } : null;
      if (key) keys.push(key);
      return key;
    };
    let invocation: B409Invocation;
    try {
      invocation = JSON.parse(JSON.stringify(raw)) as B409Invocation;
    } catch {
      throw forbidden();
    }
    const began = this.deps.now();
    const result = await verifyB409Invocation(invocation,
      capture(this.deps.assertionKeys), capture(this.deps.workloadKeys), began);
    if (!result.provenanceVerified) throw forbidden();
    const { claims } = invocation.assertion;
    if (claims.operation !== 'loyalty:confirmed-purchase-count' || claims.permission !== 'loyalty:serve' ||
        claims.businessId !== businessId || claims.branchId !== branchId) throw forbidden();
    let connection: RestrictedConnection;
    try {
      connection = await this.deps.connect();
    } catch {
      throw unavailable();
    }
    let discard = false;
    try {
      const now = this.deps.now();
      const expiresAt = Math.min(claims.expiresAt, invocation.workloadEvidence.expiresAt, ...keys.map(k => k.notAfter));
      if (!Number.isSafeInteger(now) || now < began || now >= expiresAt ||
          keys.length !== 2 || !keys.every(key => validBrokerKey(key, now))) throw forbidden();
      const { rows } = await connection.query(sql, [
        claims.actorId, claims.sessionId, businessId, branchId, claims.nonce, expiresAt * 1000,
      ]);
      const row = rows[0];
      if (rows.length !== 1 || !row) throw unavailable();
      if (row.outcome === 'REPLAYED' || typeof row.outcome === 'string' && row.outcome.startsWith('DENIED_')) {
        throw forbidden();
      }
      if (row.outcome !== 'OK' || typeof row.purchase_count !== 'number' ||
          !Number.isSafeInteger(row.purchase_count) || row.purchase_count < 0) throw unavailable();
      return row.purchase_count;
    } catch (error) {
      if (error instanceof AppError && error.status === 403) throw error;
      discard = true;
      throw unavailable();
    } finally {
      connection.release(discard);
    }
  }
}
