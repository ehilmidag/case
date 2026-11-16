import { StateRow, transition, TransitionConfig } from './transition';

const config: TransitionConfig = {
  exitConfirmPoints: 3,
  exitConfirmMs: 30_000,
  stateRefreshMs: 300_000,
};

function date(milliseconds: number): Date {
  return new Date(milliseconds);
}

function state(overrides: Partial<StateRow> = {}): StateRow {
  return {
    areaId: 'area-a',
    enteredAt: date(1_000),
    lastInsideAt: date(1_000),
    outsideCount: 0,
    firstOutsideAt: null,
    ...overrides,
  };
}

describe('transition', () => {
  it('creates an entry and initial state the first time a user enters an area', () => {
    const point = date(10_000);

    expect(transition([], { ts: point }, ['area-a'], config)).toEqual({
      entries: [{ areaId: 'area-a', enteredAt: point }],
      exits: [],
      upserts: [
        {
          areaId: 'area-a',
          enteredAt: point,
          lastInsideAt: point,
          outsideCount: 0,
          firstOutsideAt: null,
        },
      ],
      deletes: [],
    });
  });

  it('does not write an unchanged state before the refresh threshold', () => {
    const previous = state();

    expect(transition([previous], { ts: date(100_000) }, ['area-a'], config)).toEqual({
      entries: [],
      exits: [],
      upserts: [],
      deletes: [],
    });
  });

  it('refreshes lastInsideAt at the configured state refresh threshold', () => {
    const previous = state();
    const point = date(301_000);

    expect(transition([previous], { ts: point }, ['area-a'], config).upserts).toEqual([
      { ...previous, lastInsideAt: point },
    ]);
  });

  it('resets pending exit confirmations on re-entry without creating another entry', () => {
    const previous = state({ outsideCount: 2, firstOutsideAt: date(5_000) });
    const point = date(10_000);
    const result = transition([previous], { ts: point }, ['area-a'], config);

    expect(result.entries).toEqual([]);
    expect(result.upserts).toEqual([
      { ...previous, lastInsideAt: point, outsideCount: 0, firstOutsideAt: null },
    ]);
    expect(result.exits).toEqual([]);
  });

  it('confirms exit after the configured number of consecutive outside points', () => {
    const previous = state({ outsideCount: 2, firstOutsideAt: date(5_000) });

    expect(transition([previous], { ts: date(9_000) }, [], config)).toEqual({
      entries: [],
      exits: [{ areaId: 'area-a', enteredAt: previous.enteredAt, exitedAt: date(5_000) }],
      upserts: [],
      deletes: ['area-a'],
    });
  });

  it('confirms exit after the configured outside duration', () => {
    const previous = state({ outsideCount: 1, firstOutsideAt: date(5_000) });
    const result = transition([previous], { ts: date(35_000) }, [], config);

    expect(result.exits).toEqual([
      { areaId: 'area-a', enteredAt: previous.enteredAt, exitedAt: date(5_000) },
    ]);
    expect(result.deletes).toEqual(['area-a']);
  });

  it('creates a new entry only after a confirmed exit', () => {
    const previous = state({ outsideCount: 2, firstOutsideAt: date(5_000) });
    const exit = transition([previous], { ts: date(9_000) }, [], config);
    const nextPoint = date(20_000);
    const reentry = transition([], { ts: nextPoint }, ['area-a'], config);

    expect(exit.deletes).toEqual(['area-a']);
    expect(reentry.entries).toEqual([{ areaId: 'area-a', enteredAt: nextPoint }]);
  });

  it('enters overlapping areas and processes points as a chained batch', () => {
    const firstPoint = date(10_000);
    const first = transition([], { ts: firstPoint }, ['area-a', 'area-b'], config);
    const nextPoint = date(20_000);
    const second = transition(first.upserts, { ts: nextPoint }, ['area-a'], config);

    expect(first.entries.map(({ areaId }) => areaId)).toEqual(['area-a', 'area-b']);
    expect(second.upserts).toEqual([
      ...first.upserts
        .filter(({ areaId }) => areaId === 'area-b')
        .map((row) => ({
          ...row,
          outsideCount: 1,
          firstOutsideAt: nextPoint,
        })),
    ]);
    expect(second.entries).toEqual([]);
  });

  it('does not mutate previous rows or the input timestamp', () => {
    const previous = state({ outsideCount: 1 });
    const point = date(10_000);
    const original = { ...previous };
    const originalPoint = point.getTime();

    transition([previous], { ts: point }, ['area-a'], config);

    expect(previous).toEqual(original);
    expect(point.getTime()).toBe(originalPoint);
  });
});
