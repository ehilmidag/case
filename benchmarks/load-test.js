// Faz 10.6: POST /locations'ı kademeli olarak 2.000, 10.000 ve 20.000 nokta/sn hedefleyerek
// yükler. Her hedef, env değişkenleriyle ayrı bir `k6 run` çağrısı olarak çalıştırılır
// (bkz. benchmarks/run-load-test.sh), böylece her aşamanın p95/p99'u kendi özetinde ayrı
// ayrı görünür.
//
// Tek bir HTTP isteği MAX_BATCH_LOCATIONS'a kadar nokta taşıyabildiği için, nokta/sn
// hedefine BATCH_SIZE büyüklüğünde batch'lerle ulaşılır: istek/sn = nokta/sn / BATCH_SIZE.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 20);
const TARGET_POINTS_PER_SEC = Number(__ENV.TARGET_POINTS_PER_SEC || 2000);
const RAMP_SEC = Number(__ENV.RAMP_SEC || 10);
const HOLD_SEC = Number(__ENV.HOLD_SEC || 30);
const REGION = { minLng: 29, maxLng: 30, minLat: 41, maxLat: 42 };

const targetRequestRate = Math.max(1, Math.round(TARGET_POINTS_PER_SEC / BATCH_SIZE));
const batchLatency = new Trend('batch_post_duration');

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(500, targetRequestRate * 2 + 20),
      maxVUs: Math.min(2000, targetRequestRate * 4 + 50),
      stages: [
        { target: targetRequestRate, duration: `${RAMP_SEC}s` },
        { target: targetRequestRate, duration: `${HOLD_SEC}s` },
        { target: 0, duration: '5s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function buildBatch() {
  const now = Date.now();
  const locations = [];
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    locations.push({
      userId: `k6-user-${Math.floor(Math.random() * 20000)}`,
      latitude: randomInRange(REGION.minLat, REGION.maxLat),
      longitude: randomInRange(REGION.minLng, REGION.maxLng),
      timestamp: new Date(now + i).toISOString(),
    });
  }
  return { locations };
}

function randomIp() {
  // Load istemcisi her istek için tek bir kaynak IP'den bağlanır; gerçek dünyada bu hacim
  // binlerce ayrı mobil cihazdan gelir, her biri kendi per-IP rate limitinin çok altında.
  // X-Forwarded-For (API `trust proxy` ayarıyla güveniyor) ile bunu simüle etmek hem daha
  // gerçekçi hem de @nestjs/throttler'ın bellek-içi storage'ının tek bir anahtar için
  // sınırsız büyüyen hit dizisini (ve onun her istekte O(n) taranmasını) önlüyor.
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default function () {
  const payload = JSON.stringify(buildBatch());
  const response = http.post(`${BASE_URL}/locations`, payload, {
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': randomIp() },
  });
  batchLatency.add(response.timings.duration);
  check(response, { 'status is 202': (r) => r.status === 202 });
}
