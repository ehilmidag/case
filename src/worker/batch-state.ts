import { StateRow, StateTransition } from '../state/transition';

export type AggregatedChanges = {
  entries: StateTransition['entries'];
  exits: StateTransition['exits'];
  upserts: StateRow[];
  deletes: string[];
};

// Reconstructs a user's full area-state after one transition() call. transition() only
// reports what changed — its own type comment calls `upserts` "değişen satırlar" (changed
// rows only) — so a row left untouched this round (e.g. still inside, but under the
// state-refresh threshold) is absent from the result. Chaining batches by passing
// `result.upserts` straight back in as the next point's `prev` would drop that row, and
// the next point matching the same area would see no prior row and wrongly create a
// second entry for an area the user never left.
export function applyTransitionToState(
  previousFull: StateRow[],
  result: StateTransition,
): StateRow[] {
  const deleted = new Set(result.deletes);
  const upsertedAreaIds = new Set(result.upserts.map((row) => row.areaId));
  const untouched = previousFull.filter(
    (row) => !deleted.has(row.areaId) && !upsertedAreaIds.has(row.areaId),
  );
  return [...untouched, ...result.upserts];
}

// Merges the per-point transition() results for one user's batch into the writes for a
// single applyChanges call. Entries/exits are permanent log rows keyed by (areaId,
// enteredAt), so every occurrence across the batch is kept as-is. Upserts/deletes key
// only by (userId, areaId): concatenating them raw can hand Postgres's
// `ON CONFLICT (user_id, area_id) DO UPDATE` the same pair twice in one statement, which
// it rejects with "ON CONFLICT DO UPDATE command cannot affect row a second time". Folding
// to the latest state per areaId — letting a later delete evict an earlier upsert, and a
// later re-entry evict an earlier delete — keeps only the end-of-batch net effect.
export function aggregateBatchChanges(results: StateTransition[]): AggregatedChanges {
  const entries: StateTransition['entries'] = [];
  const exits: StateTransition['exits'] = [];
  const upsertsByAreaId = new Map<string, StateRow>();
  const deletedAreaIds = new Set<string>();

  for (const result of results) {
    entries.push(...result.entries);
    exits.push(...result.exits);

    for (const row of result.upserts) {
      upsertsByAreaId.set(row.areaId, row);
      deletedAreaIds.delete(row.areaId);
    }

    for (const areaId of result.deletes) {
      upsertsByAreaId.delete(areaId);
      deletedAreaIds.add(areaId);
    }
  }

  return {
    entries,
    exits,
    upserts: [...upsertsByAreaId.values()],
    deletes: [...deletedAreaIds],
  };
}
