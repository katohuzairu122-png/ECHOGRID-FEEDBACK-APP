type FeedbackFilter = 'branchId' | 'search' | 'savedView' | 'category' | 'urgency' | 'offset';

/** Keep the committed URL filters, including repeated values, until explicitly changed. */
export function feedbackFilterHref(
  filterQuery: string,
  changes: Partial<Record<FeedbackFilter, string>>,
): string {
  const params = new URLSearchParams(filterQuery);
  params.delete('offset');
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `/dashboard/feedback?${query}` : '/dashboard/feedback';
}
