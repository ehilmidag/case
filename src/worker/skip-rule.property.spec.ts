import * as fc from 'fast-check';
import { latLngToCell } from 'h3-js';
import { AreaGeometry } from '../geofence/geofence-index';
import { RTreeGeofenceIndex } from '../geofence/rtree-geofence-index';
import { applyTransitionToState } from './batch-state';
import { shouldSkipEvaluation } from './skip-rule';
import { StateRow, transition, TransitionConfig } from '../state/transition';

// Faz 10.5: "'Atla' kararı verilen her durumda tam değerlendirmenin de aynı sonucu
// verdiğini property-based testle doğrula." Runs the same random point sequence through
// two independent simulations of a user's trajectory: one applies the real skip rule
// (shouldSkipEvaluation, exactly as BatchProcessorService wires it), the other evaluates
// every single point. If skipping ever changed the observable outcome, the two runs'
// entries/exits would diverge.
function rectangle(
  id: string,
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): AreaGeometry {
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ],
    },
  };
}

const AREAS = [
  rectangle('a', 0, 0, 0.02, 0.02),
  rectangle('b', 0.015, 0.015, 0.035, 0.035),
  rectangle('c', -0.03, -0.03, -0.01, -0.01),
];
const H3_SKIP_RESOLUTION = 8;
const FORCE_EVAL_MS = 1000;
const TRANSITION_CONFIG: TransitionConfig = {
  exitConfirmPoints: 3,
  exitConfirmMs: 5000,
  stateRefreshMs: 2000,
};

type Step = { dLat: number; dLng: number; dt: number };

type RunOutcome = {
  entries: Array<{ areaId: string; enteredAt: Date }>;
  exits: Array<{ areaId: string; enteredAt: Date; exitedAt: Date }>;
  skippedCount: number;
  evaluatedCount: number;
};

type SimulatedFilter = {
  ts: number;
  cell: string;
  evalTs: number | null;
  stable: boolean;
};

type SimAccumulator = {
  state: StateRow[];
  filter: SimulatedFilter | null;
  entries: RunOutcome['entries'];
  exits: RunOutcome['exits'];
  skippedCount: number;
  evaluatedCount: number;
};

function simulateStep(
  index: RTreeGeofenceIndex,
  applySkip: boolean,
  acc: SimAccumulator,
  point: { lat: number; lng: number; ts: number },
): SimAccumulator {
  const currentFilter = acc.filter;
  if (currentFilter !== null && point.ts <= currentFilter.ts) {
    return acc;
  }

  const cell = latLngToCell(point.lat, point.lng, H3_SKIP_RESOLUTION);

  if (applySkip && currentFilter !== null) {
    const skip = shouldSkipEvaluation(
      currentFilter,
      point,
      cell,
      index.isUniformCell(cell),
      FORCE_EVAL_MS,
    );
    if (skip) {
      const nextFilter: SimulatedFilter = { ...currentFilter, ts: point.ts, cell };
      return { ...acc, filter: nextFilter, skippedCount: acc.skippedCount + 1 };
    }
  }

  const matched = index.findContaining(point.lat, point.lng);
  const result = transition(acc.state, { ts: new Date(point.ts) }, matched, TRANSITION_CONFIG);
  const nextState = applyTransitionToState(acc.state, result);
  const stable = nextState.every((row) => row.outsideCount === 0);
  const nextFilter: SimulatedFilter = { ts: point.ts, cell, evalTs: point.ts, stable };

  return {
    state: nextState,
    filter: nextFilter,
    entries: [...acc.entries, ...result.entries],
    exits: [...acc.exits, ...result.exits],
    skippedCount: acc.skippedCount,
    evaluatedCount: acc.evaluatedCount + 1,
  };
}

function simulate(
  index: RTreeGeofenceIndex,
  startLat: number,
  startLng: number,
  startTs: number,
  steps: Step[],
  options: { applySkip: boolean },
): RunOutcome {
  let lat = startLat;
  let lng = startLng;
  let ts = startTs;

  const points = [
    { lat, lng, ts },
    ...steps.map((step) => {
      lat += step.dLat;
      lng += step.dLng;
      ts += step.dt;
      return { lat, lng, ts };
    }),
  ];

  const initial: SimAccumulator = {
    state: [],
    filter: null,
    entries: [],
    exits: [],
    skippedCount: 0,
    evaluatedCount: 0,
  };

  const final = points.reduce<SimAccumulator>(
    (acc, point) => simulateStep(index, options.applySkip, acc, point),
    initial,
  );

  return {
    entries: final.entries,
    exits: final.exits,
    skippedCount: final.skippedCount,
    evaluatedCount: final.evaluatedCount,
  };
}

describe('skip-rule equivalence (Faz 10.5)', () => {
  const index = new RTreeGeofenceIndex();

  beforeAll(() => {
    index.rebuild(AREAS, 1);
  });

  it('produces identical entries/exits whether or not the skip optimization runs', () => {
    let totalSkipped = 0;
    let totalEvaluated = 0;

    fc.assert(
      fc.property(
        fc.double({ min: -0.05, max: 0.05, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -0.05, max: 0.05, noNaN: true, noDefaultInfinity: true }),
        fc.array(
          fc.record({
            dLat: fc.double({ min: -0.004, max: 0.004, noNaN: true, noDefaultInfinity: true }),
            dLng: fc.double({ min: -0.004, max: 0.004, noNaN: true, noDefaultInfinity: true }),
            dt: fc.integer({ min: 50, max: 400 }),
          }),
          { minLength: 5, maxLength: 40 },
        ),
        (startLat, startLng, steps) => {
          const startTs = 1_700_000_000_000;
          const withSkip = simulate(index, startLat, startLng, startTs, steps, {
            applySkip: true,
          });
          const withoutSkip = simulate(index, startLat, startLng, startTs, steps, {
            applySkip: false,
          });

          totalSkipped += withSkip.skippedCount;
          totalEvaluated += withSkip.evaluatedCount;

          expect(withSkip.entries).toEqual(withoutSkip.entries);
          expect(withSkip.exits).toEqual(withoutSkip.exits);
        },
      ),
      { numRuns: 2000 },
    );

    // Guards against the property being vacuously true because the skip rule's
    // preconditions never actually hold across any generated trajectory.
    expect(totalSkipped).toBeGreaterThan(0);
    expect(totalEvaluated).toBeGreaterThan(0);
  });
});
