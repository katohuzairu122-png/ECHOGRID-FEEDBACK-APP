import type { Database } from '../db/client';
import {
  createRepositories,
  type CommunityPointAccount,
  type CommunityPointTransaction,
} from '../repositories';

export interface CommunityPointCustomerSummary {
  account: CommunityPointAccount | null;
}

export class CommunityPointCustomerService {
  constructor(private readonly db: Database) {}

  async getSummary(customerId: string): Promise<CommunityPointCustomerSummary> {
    const account = await createRepositories(this.db).communityPointAccounts.findByCustomerId(
      customerId,
    );
    return { account: account ?? null };
  }

  async listTransactions(
    customerId: string,
    options: { limit: number; offset: number },
  ): Promise<CommunityPointTransaction[]> {
    return createRepositories(this.db).communityPointTransactions.listForCustomer(
      customerId,
      options,
    );
  }
}
