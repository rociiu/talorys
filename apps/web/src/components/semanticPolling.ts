/** The parts of GET /api/semantic/status that decide whether the Settings card keeps polling. */
export interface PollableSemanticStatus {
  pending: number;
  items?: { indexing?: boolean };
}

/**
 * Poll every 3 s while memories are pending or an item pass is running. Pending items alone do not
 * count: they are embedded by the next chat turn or search, so waiting on them would poll forever.
 */
export function statusRefetchInterval(status: PollableSemanticStatus | undefined): 3000 | false {
  if (!status) return false;
  return status.pending > 0 || status.items?.indexing === true ? 3000 : false;
}
