import { transition, TransitionConfig } from '../state/transition';
import { aggregateBatchChanges, applyTransitionToState } from './batch-state';

const config: TransitionConfig = {
  exitConfirmPoints: 3,
  exitConfirmMs: 30_000,
  stateRefreshMs: 300_000,
};

function date(ms: number): Date {
  return new Date(ms);
}

describe('applyTransitionToState', () => {
  it('carries forward a row untouched by this point, so a later point in the same batch does not re-enter it', () => {
    const entered = transition([], { ts: date(0) }, ['area-a', 'area-b'], config);
    let state = applyTransitionToState([], entered);
    expect(state.map((row) => row.areaId).sort()).toEqual(['area-a', 'area-b']);

    // Second point only matches area-a, well under the refresh threshold: area-a's row
    // has nothing written (transition()'s "do nothing" branch), so it is absent from
    // `upserts`. area-b stays matched too, also under the threshold.
    const second = transition(state, { ts: date(1_000) }, ['area-a', 'area-b'], config);
    expect(second.upserts).toEqual([]);
    expect(second.entries).toEqual([]);
    state = applyTransitionToState(state, second);

    // Both rows must still be present — this is exactly what a buggy
    // `state = second.upserts` chain would lose, since second.upserts is empty.
    expect(state.map((row) => row.areaId).sort()).toEqual(['area-a', 'area-b']);

    // A third point that only matches area-a must NOT re-enter area-b or area-a.
    const third = transition(state, { ts: date(2_000) }, ['area-a'], config);
    expect(third.entries).toEqual([]);
  });

  it('removes a row once exit is confirmed by consecutive outside points', () => {
    const entered = transition([], { ts: date(0) }, ['area-a'], config);
    let state = applyTransitionToState([], entered);

    const outside1 = transition(state, { ts: date(10_000) }, [], config);
    state = applyTransitionToState(state, outside1);
    const outside2 = transition(state, { ts: date(20_000) }, [], config);
    state = applyTransitionToState(state, outside2);
    const outside3 = transition(state, { ts: date(30_000) }, [], config);
    expect(outside3.deletes).toEqual(['area-a']);

    const next = applyTransitionToState(state, outside3);
    expect(next).toEqual([]);
  });
});

describe('aggregateBatchChanges', () => {
  it('keeps every entries/exits occurrence but folds upserts to the latest row per area', () => {
    const point1 = transition([], { ts: date(0) }, ['area-a'], config);
    let state = applyTransitionToState([], point1);
    const point2 = transition(state, { ts: date(301_000) }, ['area-a'], config);
    state = applyTransitionToState(state, point2);

    const aggregated = aggregateBatchChanges([point1, point2]);

    expect(aggregated.entries).toEqual([{ areaId: 'area-a', enteredAt: date(0) }]);
    expect(aggregated.upserts).toHaveLength(1);
    expect(aggregated.upserts[0]).toMatchObject({ areaId: 'area-a', lastInsideAt: date(301_000) });
  });

  it('lets a later delete evict an earlier upsert for the same area', () => {
    const enter = transition([], { ts: date(0) }, ['area-a'], config);
    let state = applyTransitionToState([], enter);
    const stillIn = transition(state, { ts: date(301_000) }, ['area-a'], config);
    state = applyTransitionToState(state, stillIn);
    const outside1 = transition(state, { ts: date(310_000) }, [], config);
    state = applyTransitionToState(state, outside1);
    const outside2 = transition(state, { ts: date(320_000) }, [], config);
    state = applyTransitionToState(state, outside2);
    const outside3 = transition(state, { ts: date(330_000) }, [], config);
    expect(outside3.deletes).toEqual(['area-a']);

    const aggregated = aggregateBatchChanges([enter, stillIn, outside1, outside2, outside3]);

    expect(aggregated.upserts).toEqual([]);
    expect(aggregated.deletes).toEqual(['area-a']);
    expect(aggregated.exits).toEqual([
      { areaId: 'area-a', enteredAt: date(0), exitedAt: date(310_000) },
    ]);
  });

  it('lets a later re-entry within the same batch evict an earlier delete for the same area', () => {
    const enter = transition([], { ts: date(0) }, ['area-a'], config);
    let state = applyTransitionToState([], enter);
    const outside1 = transition(state, { ts: date(10_000) }, [], config);
    state = applyTransitionToState(state, outside1);
    const outside2 = transition(state, { ts: date(20_000) }, [], config);
    state = applyTransitionToState(state, outside2);
    const outside3 = transition(state, { ts: date(30_000) }, [], config);
    state = applyTransitionToState(state, outside3);
    const reenter = transition(state, { ts: date(40_000) }, ['area-a'], config);

    const aggregated = aggregateBatchChanges([enter, outside1, outside2, outside3, reenter]);

    expect(aggregated.deletes).toEqual([]);
    expect(aggregated.upserts).toHaveLength(1);
    expect(aggregated.upserts[0]).toMatchObject({
      areaId: 'area-a',
      enteredAt: date(40_000),
    });
    expect(aggregated.entries).toEqual([
      { areaId: 'area-a', enteredAt: date(0) },
      { areaId: 'area-a', enteredAt: date(40_000) },
    ]);
  });
});
