export type StateRow = {
  areaId: string;
  enteredAt: Date;
  lastInsideAt: Date;
  outsideCount: number;
  firstOutsideAt: Date | null;
};

export type TransitionPoint = {
  ts: Date;
};

export type TransitionConfig = {
  exitConfirmPoints: number;
  exitConfirmMs: number;
  stateRefreshMs: number;
};

export type StateTransition = {
  entries: Array<{ areaId: string; enteredAt: Date }>;
  exits: Array<{ areaId: string; enteredAt: Date; exitedAt: Date }>;
  upserts: StateRow[];
  deletes: string[];
};

export function transition(
  prev: StateRow[],
  point: TransitionPoint,
  matchedAreaIds: string[],
  config: TransitionConfig,
): StateTransition {
  const previousByAreaId = new Map(prev.map((state) => [state.areaId, state]));
  const matched = new Set(matchedAreaIds);
  const entries: StateTransition['entries'] = [];
  const exits: StateTransition['exits'] = [];
  const upserts: StateRow[] = [];
  const deletes: string[] = [];
  const ts = new Date(point.ts.getTime());

  for (const areaId of [...matched].sort()) {
    const previous = previousByAreaId.get(areaId);
    if (!previous) {
      entries.push({ areaId, enteredAt: ts });
      upserts.push({
        areaId,
        enteredAt: ts,
        lastInsideAt: ts,
        outsideCount: 0,
        firstOutsideAt: null,
      });
      continue;
    }

    if (previous.outsideCount > 0) {
      upserts.push({
        ...previous,
        lastInsideAt: ts,
        outsideCount: 0,
        firstOutsideAt: null,
      });
      continue;
    }

    if (ts.getTime() - previous.lastInsideAt.getTime() >= config.stateRefreshMs) {
      upserts.push({ ...previous, lastInsideAt: ts });
    }
  }

  for (const previous of [...prev].sort((left, right) => left.areaId.localeCompare(right.areaId))) {
    if (matched.has(previous.areaId)) {
      continue;
    }

    const firstOutsideAt = previous.firstOutsideAt ?? ts;
    const outsideCount = previous.outsideCount + 1;
    const confirmedByPoints = outsideCount >= config.exitConfirmPoints;
    const confirmedByTime = ts.getTime() - firstOutsideAt.getTime() >= config.exitConfirmMs;

    if (confirmedByPoints || confirmedByTime) {
      exits.push({
        areaId: previous.areaId,
        enteredAt: previous.enteredAt,
        exitedAt: new Date(firstOutsideAt.getTime()),
      });
      deletes.push(previous.areaId);
      continue;
    }

    upserts.push({ ...previous, outsideCount, firstOutsideAt });
  }

  return { entries, exits, upserts, deletes };
}
