/** How the Messages list should react to a failed conversations read (never an empty list, never a crash). */
export type MessagesFailure = 'login' | 'forbidden' | 'unavailable';

export function classifyMessagesError(error: unknown): MessagesFailure {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}
