/**
 * Read-only Community Feed DTO and source port. Runtime schemas are shared with
 * the web boundary; publication eligibility remains the Network source's job.
 * The source never reads loyalty, points, feedback, survey or messaging data.
 */
import {
  NETWORK_FEED_CONTENT_CLASSES,
  networkFeedItemSchema,
  type NetworkFeedItemDto,
  type NetworkFeedPageDto,
} from '@echo-grid-feedback/shared-types';

export const FEED_CONTENT_CLASSES = NETWORK_FEED_CONTENT_CLASSES;
export type FeedContentClass = (typeof FEED_CONTENT_CLASSES)[number];
export type FeedItemDto = NetworkFeedItemDto;
export type FeedPageDto = NetworkFeedPageDto;

export interface FeedListInput {
  /** Derived from the authenticated session only; never from the request. */
  customerId: string;
  cursor: string | null;
  limit: number;
}

export interface FeedSource {
  listVisible(input: FeedListInput): Promise<FeedPageDto>;
}

/** Safe empty source for tests or an explicitly unwired read model; never fabricates activity. */
export const emptyFeedSource: FeedSource = {
  async listVisible() {
    return { items: [], nextCursor: null };
  },
};

/** Validate and project the existing closed DTO; schema errors never leave the Feed route. */
export function toFeedItemDto(row: FeedItemDto): FeedItemDto {
  return networkFeedItemSchema.parse(row);
}
