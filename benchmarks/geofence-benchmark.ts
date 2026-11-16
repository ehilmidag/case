// Faz 10.7: R-tree ve H3'ü 100, 1.000 ve 10.000 alan için karşılaştırır (nokta/sn ve
// bellek kullanımı). Üretim koduna bağımlı değildir; standalone çalıştırılır:
//
//   npx tsc benchmarks/geofence-benchmark.ts --outDir /tmp/geofence-bench \
//     --target ES2022 --module commonjs --esModuleInterop --skipLibCheck --resolveJsonModule
//   node --expose-gc /tmp/geofence-bench/benchmarks/geofence-benchmark.js
//
// --expose-gc, ölçümler arasında V8'i manuel GC'ye zorlayıp temiz bir heap baseline'ı
// almak için gerekli; olmadan bellek sayıları önceki koşunun çöplerini de içerebilir.
import { AreaGeometry } from '../src/geofence/geofence-index';
import { H3GeofenceIndex } from '../src/geofence/h3-geofence-index';
import { RTreeGeofenceIndex } from '../src/geofence/rtree-geofence-index';

const AREA_COUNTS = [100, 1_000, 10_000];
const QUERY_POINT_COUNT = 50_000;
const H3_RESOLUTION = 9; // .env.example'daki H3_INDEX_RESOLUTION varsayılanı
const REGION = { minLng: 29, maxLng: 30, minLat: 41, maxLat: 42 }; // ~111km x 111km

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAreas(count: number, rng: Rng): AreaGeometry[] {
  const areas: AreaGeometry[] = [];
  for (let i = 0; i < count; i += 1) {
    // ~80m-900m per side: plan.md's "şehir veya mahalle ölçeğinde" assumption.
    const sizeLng = 0.001 + rng() * 0.007;
    const sizeLat = 0.001 + rng() * 0.007;
    const minLng = REGION.minLng + rng() * (REGION.maxLng - REGION.minLng - sizeLng);
    const minLat = REGION.minLat + rng() * (REGION.maxLat - REGION.minLat - sizeLat);
    const maxLng = minLng + sizeLng;
    const maxLat = minLat + sizeLat;

    areas.push({
      id: `area-${i}`,
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
    });
  }
  return areas;
}

function randomQueryPoints(count: number, rng: Rng): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const lng = REGION.minLng + rng() * (REGION.maxLng - REGION.minLng);
    const lat = REGION.minLat + rng() * (REGION.maxLat - REGION.minLat);
    points.push([lat, lng]);
  }
  return points;
}

function forceGc(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  } else {
    throw new Error('Run with --expose-gc for accurate memory measurements.');
  }
}

function heapUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

type Result = {
  label: string;
  areaCount: number;
  buildMs: number;
  heapDeltaMb: number;
  pointsPerSec: number;
};

function benchmarkIndex(
  label: string,
  build: () => RTreeGeofenceIndex | H3GeofenceIndex,
  areas: AreaGeometry[],
  queryPoints: Array<[number, number]>,
): Result {
  forceGc();
  const heapBefore = heapUsedMb();

  const buildStart = performance.now();
  const index = build();
  index.rebuild(areas, 1);
  const buildMs = performance.now() - buildStart;

  forceGc();
  const heapAfter = heapUsedMb();

  // Warm-up so JIT compilation of findContaining's hot path doesn't skew the timed run.
  for (const [lat, lng] of queryPoints.slice(0, 1000)) {
    index.findContaining(lat, lng);
  }

  const queryStart = performance.now();
  for (const [lat, lng] of queryPoints) {
    index.findContaining(lat, lng);
  }
  const queryMs = performance.now() - queryStart;
  const pointsPerSec = queryPoints.length / (queryMs / 1000);

  return {
    label,
    areaCount: areas.length,
    buildMs,
    heapDeltaMb: heapAfter - heapBefore,
    pointsPerSec,
  };
}

function formatRow(result: Result): string {
  return `| ${result.label} | ${result.areaCount.toLocaleString('en-US')} | ${result.buildMs.toFixed(1)} ms | ${result.heapDeltaMb.toFixed(2)} MB | ${Math.round(result.pointsPerSec).toLocaleString('en-US')} |`;
}

function main(): void {
  const rng = mulberry32(42);
  const results: Result[] = [];

  for (const areaCount of AREA_COUNTS) {
    const areas = randomAreas(areaCount, rng);
    const queryPoints = randomQueryPoints(QUERY_POINT_COUNT, rng);

    results.push(benchmarkIndex('R-tree (Flatbush)', () => new RTreeGeofenceIndex(), areas, queryPoints));
    results.push(
      benchmarkIndex('H3 (res 9)', () => new H3GeofenceIndex(H3_RESOLUTION), areas, queryPoints),
    );
  }

  console.log(`\n${QUERY_POINT_COUNT.toLocaleString('en-US')} random query points per index, ${REGION.minLng}-${REGION.maxLng}E / ${REGION.minLat}-${REGION.maxLat}N bölgesi.\n`);
  console.log('| İndeks | Alan sayısı | rebuild() süresi | Bellek (heap delta) | Nokta/sn (findContaining) |');
  console.log('|---|---|---|---|---|');
  for (const result of results) {
    console.log(formatRow(result));
  }
}

main();
