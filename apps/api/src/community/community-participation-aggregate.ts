import {
  COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR,
  type BusinessCommunityParticipation,
  type CommunityFigure,
} from '@echo-grid-feedback/shared-types';

/**
 * BCOMM-02 small-group suppression. Pure and deterministic; the only place the disclosure rule lives.
 *
 * - The group size is configuration (`COMMUNITY_AGGREGATE_MIN_GROUP_SIZE`) but can never go below the floor of 10 and falls back to the floor
 *   for anything that is not a plain whole number (fail toward more privacy).
 * - A count is shown only when the group is at least that size.
 * - Participants are also suppressed when the NON-participants would be a small group (eligible - participants < size), because the shown
 *   total and the shown participant count would otherwise reveal that small remainder by subtraction.
 * - The rate is derived from two shown figures only, and rounded to a whole percentage.
 */
const MAX_GROUP_SIZE = 1000;

export function resolveMinimumGroupSize(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR;
  const n = Number.parseInt(raw, 10);
  if (n < COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR) return COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR;
  return Math.min(n, MAX_GROUP_SIZE);
}

const shown = (value: number): CommunityFigure => ({ state: 'shown', value });
const suppressed: CommunityFigure = { state: 'suppressed' };

export function summarizeParticipation(
  counts: { eligible: number; participants: number },
  minimumGroupSize: number,
): BusinessCommunityParticipation {
  const eligible = Math.max(0, Math.trunc(counts.eligible));
  // A membership can never exceed the customers it is counted among.
  const participants = Math.min(eligible, Math.max(0, Math.trunc(counts.participants)));
  const eligibleOk = eligible >= minimumGroupSize;
  const participantsOk = participants >= minimumGroupSize && eligible - participants >= minimumGroupSize;
  return {
    minimumGroupSize,
    eligible: eligibleOk ? shown(eligible) : suppressed,
    participants: participantsOk ? shown(participants) : suppressed,
    ratePercent: eligibleOk && participantsOk ? shown(Math.round((participants * 100) / eligible)) : suppressed,
  };
}
