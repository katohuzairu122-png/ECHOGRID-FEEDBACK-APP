/** CASHIER-AUTH-02B: the shapes of the managed cashier account API (`/cashier-accounts`). No credential field exists on any of them. */
export type CashierAccessMode = 'single' | 'multiple';
export type CashierAccountStatus = 'active' | 'disabled' | 'revoked';

export interface CashierAccountDto {
  id: string;
  username: string;
  displayName: string;
  status: CashierAccountStatus;
  branches: { id: string; name: string }[];
  accessMode: CashierAccessMode | 'none';
  lastLoginAt: string | null;
  locked: boolean;
  credentialChangedAt: string | null;
  createdAt: string;
}

export interface CashierBusinessCodeDto {
  cashierCode: string | null;
  rotatedAt: string | null;
}

export interface CashierBranchOption {
  id: string;
  name: string;
}

/** Single needs exactly one branch; multiple needs two or more. The API enforces it; this only guides the form. */
export function assignmentProblem(mode: CashierAccessMode, count: number): 'single' | 'multiple' | null {
  if (mode === 'single') return count === 1 ? null : 'single';
  return count >= 2 ? null : 'multiple';
}
