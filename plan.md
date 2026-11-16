# Location Tracking Service: Uygulama Planı
 
Bu doküman, Location Tracking Service case'inin uçtan uca uygulama planıdır. Fazlar sırayla uygulanmalıdır. Her faz bir öncekinin üzerine kurulur ve her fazın sonunda testleri geçen, çalışan bir sistem olmalıdır.
 
---
 
## Kodlama ajanı için talimatlar
 
1. Fazları **sırayla** uygula. Bir fazın kabul kriterleri sağlanmadan sonrakine geçme.
2. Bu dokümandaki mimari kararları değiştirme. Değiştirmen gerekirse `docs/adr/` altına gerekçesiyle yeni bir ADR yaz.
3. Kod, tanımlayıcı (identifier) ve commit mesajları İngilizce olmalı. README ve ADR'ler Türkçe yazılabilir.
4. TypeScript `strict` modda çalışmalı. `any` kullanılmamalı (zorunluysa yorumla gerekçelendir).
5. Her iş kuralı için test yazılmalı. Testlerde Redis ve PostGIS mock'lanmamalı, gerçek servisler testcontainers ile çalıştırılmalı. Saf fonksiyonlar ise unit testlerle test edilmeli.
6. Her fazın sonunda `npm run lint && npm test` temiz geçmeli.
---
 
## 1. Problem ve hedefler
 
- Mobil istemciler, aktif oldukları süre boyunca yaklaşık her 5 saniyede bir konum gönderir.
- Sistemde poligon şeklinde coğrafi alanlar tanımlıdır. Bir kullanıcı bir alana **girdiğinde** bu giriş kaydedilir.
- Trafik zamanla büyük ölçüde artacaktır. Tasarım hedefi 100.000 eşzamanlı kullanıcı, yani yaklaşık **20.000 konum/sn**.
**Temel tasarım ilkesi:** Sistem her konumu veritabanına yazmaz, sadece **durum değişikliklerini** (giriş ve çıkışları) yazar. Konum trafiği hafif bir yoldan (API → kuyruk → bellek içi geofence) akar. Veritabanına sadece gerçek olaylar ulaşır.
 
---
 
## 2. Varsayımlar
 
Bu varsayımlar README'de de listelenmelidir.
 
- `userId` istek gövdesinden alınır ve güvenilir kabul edilir. Authentication kapsam dışıdır (production'da userId JWT'den alınmalıdır).
- `timestamp` istemciden gelir, ISO-8601 formatında ve UTC'dir. Giriş ve çıkış zamanları **noktanın kendi timestamp'i** üzerinden kaydedilir, sunucu saati kullanılmaz.
- Alanlar şehir veya mahalle ölçeğindedir. `geometry` tipi (SRID 4326) yeterlidir. Antimeridyeni kesen poligonlar desteklenmez.
- Alanlar birbiriyle çakışabilir. Bir kullanıcı aynı anda birden fazla alanın içinde olabilir.
- **Giriş**, kullanıcının bir alanın dışından içine geçmesidir. Kullanıcı alandan gerçekten çıkıp tekrar girerse yeni bir giriş kaydı oluşur.
- Alanın kenarı üzerindeki bir nokta **içeride** sayılır (`ST_Covers` semantiği).
- Sistem **at-least-once** işleme garantisi verir. Idempotency sayesinde tekrar işleme çift kayıt üretmez. Redis failover gibi çok nadir durumlarda tekrar eden bir kayıt oluşabilir, ancak kayıp oluşmaz.
- `GET /logs` replika üzerinden okuyabilir. Yeni kayıtların görünmesinde birkaç yüz milisaniyelik gecikme kabul edilebilir (eventual consistency).
---
 
## 3. Teknoloji yığını ve gerekçeler
 
| Bileşen | Seçim | Gerekçe |
|---|---|---|
| Framework | NestJS (TypeScript) | Case gereksinimi |
| Veritabanı | PostgreSQL + **PostGIS** | Mekânsal tipler, `ST_IsValid` / `ST_Covers`, GiST indeksi |
| ORM | **TypeORM** | PostGIS `geometry` tipini native destekler. Prisma'da `Unsupported` olarak kalır ve her işlem raw SQL gerektirir |
| Kuyruk | **Redis Streams** (partition'lı) | Ek bir bileşen gerektirmez, consumer group ve ack desteği var. Kafka'ya geçiş README'de ölçekleme yolu olarak anlatılır |
| Durum filtresi / cache | Redis | Kullanıcı başına `last_ts` / `last_cell`, `GET /areas` cache'i, pub/sub |
| Geofence indeksi | Bellek içi **R-tree** (flatbush + turf) ve **H3** | Konum başına DB sorgusu yapılmaz. İki uygulama aynı arayüzün arkasındadır ve config ile seçilir |
| Doğrulama | class-validator + class-transformer | NestJS standardı |
| Loglama | pino (`nestjs-pino`) | Yapılandırılmış ve hızlı |
| Metrikler | Prometheus (`prom-client`) | Kuyruk lag'i, işleme süresi, throughput |
| Health | `@nestjs/terminus` | Liveness ve readiness |
| Test | Jest, supertest, testcontainers, fast-check, k6 | Unit, e2e, property-based ve yük testleri |
 
**Bilinçli olarak tercih edilmeyenler:**
- **WebSocket:** Trafik tek yönlü ve 5 sn aralıklı. HTTP keep-alive ve batch gönderim yeterli. Stateful bağlantılar ölçeklemeyi zorlaştırır. Opsiyonel olarak Faz 12'de eklenir.
- **Dağıtık kilit (Redlock):** Bunun yerine partition'lama (tek yazar), idempotency ve koşullu yazma kullanılır.
- **BullMQ:** Konum başına bir job, bu ölçekte fazla overhead yaratır.
---
 
## 4. Mimari
 
```
Mobil istemci
     │  POST /locations (tek nokta veya batch)
     ▼
Ingest API (stateless, N instance)
     │  doğrula → XADD locations:{p}   p = hash(userId) % PARTITIONS
     │  202 Accepted
     ▼
Redis Streams (PARTITIONS adet stream)
     │  her partition'ı lease ile tek bir worker sahiplenir
     ▼
Geofence Worker (M instance)
     │  1. batch oku
     │  2. Redis filtresi (last_ts, last_cell)
     │  3. bellek içi geofence (R-tree / H3)
     │  4. PG transaction: user_area_state + area_entries
     │  5. Redis filtre güncellemesi
     │  6. XACK
     ▼
PostgreSQL + PostGIS  ◄──── Query API (GET /areas, GET /logs)
```
 
- API ve worker **aynı kod tabanından iki ayrı süreçtir**: `src/main.api.ts` ve `src/main.worker.ts`.
- **Asıl kaynak (source of truth) PostgreSQL'dir.** Redis sadece filtre, cache ve kuyruk görevi görür. Redis tamamen kaybolsa bile doğruluk korunur.
### Race condition stratejisi
 
| Risk | Çözüm |
|---|---|
| Aynı kullanıcının iki worker'da eşzamanlı işlenmesi | Partition'lama: bir kullanıcı hep aynı partition'a, o partition da tek bir worker'a gider |
| Rebalance sırasında zombi worker | `SELECT ... FOR UPDATE`, monoton artan `last_ts` ve unique constraint |
| Dual write (Redis ve DB tutarsızlığı) | Giriş kaydı ve durum güncellemesi **aynı PG transaction'ında**. Redis en son ve sadece filtre olarak güncellenir |
| Tekrar işleme | `entered_at` noktanın timestamp'idir. `UNIQUE (user_id, area_id, entered_at)` ve `ON CONFLICT DO NOTHING` |
| Sırası karışmış noktalar | `ts <= last_ts` olan noktalar elenir. Batch içinde noktalar ts'e göre sıralanır |
| Redis Cluster'da CROSSSLOT hatası | Kullanıcı anahtarlarında hash tag: `{u:<userId>}` |
| Redis failover | Redis sadece filtre olduğu için doğruluk etkilenmez |
| Replika gecikmesi | Yazmalar ve worker okumaları primary'ye, `GET /logs` replikaya gider |
| Worker'lar arasında alan versiyonu farkı | `area_set_version` hem pub/sub ile hem periyodik kontrolle yayılır. Her giriş kaydı eşleştiği versiyonu taşır |
 
---
 
## 5. Klasör yapısı
 
```
src/
  main.api.ts
  main.worker.ts
  app-api.module.ts
  app-worker.module.ts
  config/                 # env şeması (joi/zod), typed config
  common/                 # filters, interceptors, pagination (cursor), logging
  database/
    data-source.ts
    migrations/
  redis/                  # client, Lua script yükleyici, key builder'lar
  areas/                  # controller, service, dto, entity, geojson validator'ları
  locations/              # controller, ingest service, dto, partitioner
  logs/                   # controller, service, dto
  geofence/
    geofence-index.ts           # arayüz
    rtree-geofence-index.ts
    h3-geofence-index.ts
    cell-uniformity.ts          # H3 hücresinin "uniform" olup olmadığı (LRU cache'li)
    area-index.manager.ts       # yükleme, versiyon, yenileme
  state/
    transition.ts               # SAF durum geçiş fonksiyonu
    user-state.repository.ts
    redis-filter.ts             # last_ts / last_cell okuma ve yazma (Lua)
  worker/
    partition-lease.service.ts
    stream-consumer.service.ts
    batch-processor.service.ts
    timeout-sweeper.service.ts
    dlq.service.ts
  metrics/
  health/
test/
  unit/ e2e/ property/ chaos/
load/                     # k6 script'leri
bench/                    # R-tree ve H3 benchmark'ı
docs/adr/
docker-compose.yml
Dockerfile
.env.example
README.md
```
 
---
 
## 6. Konfigürasyon (`.env.example`)
 
```
NODE_ENV=development
API_PORT=3000
METRICS_PORT=9100
 
DATABASE_URL=postgres://app:app@localhost:5432/locations
DATABASE_READ_URL=                 # boşsa DATABASE_URL kullanılır
REDIS_URL=redis://localhost:6379
 
STREAM_PARTITIONS=16
STREAM_MAXLEN=2000000              # emniyet sınırı (asıl koruma backpressure)
BACKPRESSURE_MAX_PENDING=500000    # toplam bekleyen mesaj eşiği → 503
WORKER_BATCH_SIZE=500
WORKER_BLOCK_MS=1000
PARTITION_LEASE_TTL_MS=15000
PARTITION_LEASE_RENEW_MS=5000
MAX_DELIVERY_ATTEMPTS=5
 
GEOFENCE_INDEX=rtree               # rtree | h3
H3_INDEX_RESOLUTION=9
H3_SKIP_RESOLUTION=11              # sabit kullanıcı atlama kontrolü için
AREA_INDEX_REFRESH_MS=30000
 
EXIT_CONFIRM_POINTS=3              # çıkışın kesinleşmesi için ardışık dışarıda nokta sayısı
EXIT_CONFIRM_MS=30000              # ...veya ilk dışarıda noktasından bu yana geçen süre
FORCE_EVAL_MS=60000                # atlama olsa bile en geç bu sürede tam değerlendirme yap
STATE_REFRESH_MS=300000            # last_inside_at en geç bu sürede bir yenilenir
SIGNAL_TIMEOUT_MS=600000           # sinyal yoksa zaman aşımıyla çıkış
SWEEPER_INTERVAL_MS=60000
 
USER_FILTER_TTL_S=3600
TS_MAX_FUTURE_MS=60000
TS_MAX_PAST_MS=86400000
MAX_BATCH_LOCATIONS=100
MAX_POLYGON_VERTICES=10000
RATE_LIMIT_PER_MIN=120
```
 
Kurallar: `STATE_REFRESH_MS < SIGNAL_TIMEOUT_MS` ve `FORCE_EVAL_MS < STATE_REFRESH_MS` olmalı. Uygulama açılışta bunları doğrulamalı ve koşul sağlanmazsa başlamamalı.
 
---
 
## 7. Veri modeli
 
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
 
-- Alanlar
CREATE TABLE areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  geom        geometry(Polygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
  is_active   boolean NOT NULL DEFAULT true,
  version     bigint  NOT NULL,                 -- oluşturulduğu area_set_version
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX areas_geom_gix       ON areas USING GIST (geom);
CREATE INDEX areas_created_id_idx ON areas (created_at DESC, id DESC);
 
CREATE SEQUENCE area_set_version_seq;
 
-- Giriş kayıtları (log)
CREATE TABLE area_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  user_id           text        NOT NULL,
  area_id           uuid        NOT NULL,       -- partition'lı tabloda FK yerine uygulama tutarlılığı
  entered_at        timestamptz NOT NULL,
  exited_at         timestamptz,
  exit_reason       text CHECK (exit_reason IN ('left','timeout','area_deleted')),
  area_set_version  bigint      NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, entered_at),
  UNIQUE (user_id, area_id, entered_at)
) PARTITION BY RANGE (entered_at);
 
CREATE INDEX ON area_entries (user_id, entered_at DESC, id DESC);
CREATE INDEX ON area_entries (area_id, entered_at DESC, id DESC);
CREATE INDEX ON area_entries (entered_at DESC, id DESC);
-- Aylık partition'lar: migration'da mevcut ay + 3 ay oluşturulur, ayrıca DEFAULT partition.
-- Yeni partition'ları oluşturan bakım job'u (ya da pg_partman) README'de anlatılır.
 
-- Kullanıcının şu an içinde olduğu alanlar (asıl kaynak)
CREATE TABLE user_area_state (
  user_id           text        NOT NULL,
  area_id           uuid        NOT NULL REFERENCES areas(id),
  entered_at        timestamptz NOT NULL,       -- ilgili area_entries kaydını bulmak için
  last_inside_at    timestamptz NOT NULL,
  outside_count     int         NOT NULL DEFAULT 0,
  first_outside_at  timestamptz,
  PRIMARY KEY (user_id, area_id)
);
CREATE INDEX ON user_area_state (last_inside_at);
```
 
**Redis anahtarları:**
 
| Anahtar | Tip | İçerik |
|---|---|---|
| `locations:{p}` | Stream | Konum mesajları. `p` = partition |
| `locations:dlq` | Stream | İşlenemeyen mesajlar |
| `lease:partition:{p}` | String | Partition'ı tutan worker id'si (TTL'li) |
| `{u:<userId>}:f` | Hash | `ts`, `cell`, `evalTs`, `stable` (TTL: `USER_FILTER_TTL_S`) |
| `areas:list:<version>:<query-hash>` | String | `GET /areas` cache'i |
| `area_set_version` | String | Güncel alan seti versiyonu |
| `areas.changed` | Pub/Sub kanalı | Yeni versiyon numarası |
 
**Stream mesaj formatı:**
```json
{ "userId": "u-123", "lat": 41.04, "lng": 29.02, "ts": 1763060000000, "receivedAt": 1763060000150 }
```
 
---
 
## 8. API sözleşmeleri
 
### POST /locations
 
İstek gövdesi tek nokta veya batch olabilir:
 
```json
{ "userId": "u-123", "latitude": 41.0405, "longitude": 29.0213, "timestamp": "2026-11-13T19:00:00Z" }
```
```json
{ "locations": [ { "userId": "u-123", "latitude": 41.0405, "longitude": 29.0213, "timestamp": "2026-11-13T19:00:00Z" } ] }
```
 
Doğrulama kuralları:
- `userId`: 1–128 karakter.
- `latitude` ∈ [-90, 90], `longitude` ∈ [-180, 180].
- `timestamp`: ISO-8601, `now - TS_MAX_PAST_MS` ile `now + TS_MAX_FUTURE_MS` arasında.
- Batch en fazla `MAX_BATCH_LOCATIONS` nokta içerebilir.
Yanıtlar:
- `202 Accepted`: `{ "accepted": <n> }`
- `400`: Doğrulama hatası. Batch'te hatalı noktanın indeksi belirtilir.
- `429`: Rate limit aşıldı.
- `503` + `Retry-After`: Backpressure, yani bekleyen mesaj sayısı eşiği aştı.
### POST /areas
 
```json
{
  "name": "Kadıköy Merkez",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[29.0230,40.9900],[29.0330,40.9900],[29.0330,40.9960],[29.0230,40.9960],[29.0230,40.9900]]]
  }
}
```
 
Kurallar:
- Koordinat sırası `[lng, lat]` (GeoJSON standardı).
- Her ring kapalı ve en az 4 noktalı olmalı. Delikli poligonlar (ek ring'ler) desteklenir.
- Toplam nokta sayısı en fazla `MAX_POLYGON_VERTICES` olabilir.
- `ST_IsValid` false ise `422` döner ve gövdede `ST_IsValidReason` çıktısı yer alır. `ST_MakeValid` **kullanılmaz**.
Yanıt `201 Created`, `Location: /areas/<id>` header'ı ve gövdede GeoJSON Feature:
```json
{ "type": "Feature", "id": "<uuid>", "geometry": { ... }, "properties": { "name": "...", "createdAt": "...", "version": 7 } }
```
 
### GET /areas
 
Sorgu parametreleri:
- `limit` (varsayılan 50, en fazla 500)
- `cursor` (opak, base64 `(created_at, id)`)
- `bbox=minLng,minLat,maxLng,maxLat` (opsiyonel, `&&` operatörü ve GiST indeksiyle çalışır)
Yanıt: `{ "type": "FeatureCollection", "features": [...], "nextCursor": "..." | null }`
 
`ETag` header'ı alan seti versiyonu ve sorgu hash'inden üretilir. `If-None-Match` eşleşirse `304` döner.
 
### GET /logs
 
Sorgu parametreleri: `userId`, `areaId`, `from`, `to` (ISO-8601, `entered_at` üzerinden), `limit`, `cursor` (`(entered_at, id)`).
 
Yanıt:
```json
{
  "items": [
    { "id": "123", "userId": "u-123", "areaId": "<uuid>", "entryTime": "...", "exitTime": null, "exitReason": null }
  ],
  "nextCursor": "..." | null
}
```
 
### Diğer endpoint'ler
 
- `GET /health/live`, `GET /health/ready`: DB ve Redis kontrolü.
- `GET /metrics`: Prometheus metrikleri, ayrı portta.
- `GET /docs`: Swagger.
---
 
## 9. Çekirdek algoritmalar
 
### 9.1 Geofence indeksi
 
```ts
export interface GeofenceIndex {
  readonly version: number;
  rebuild(areas: AreaGeometry[], version: number): void;
  findContaining(lat: number, lng: number): string[];   // areaId listesi
  isUniformCell(cell: string): boolean;                  // H3 hücresi hiçbir alan sınırını kesmiyorsa true
}
```
 
- **R-tree:** Flatbush ile her alanın bbox'ı indekslenir. Aday alanlar için `@turf/boolean-point-in-polygon` çalıştırılır. Kenar üzerindeki nokta içeride sayılır (`ignoreBoundary: false`).
- **H3:** Her alan `polygonToCells` ile hücrelere bölünür. Her hücre ya **iç** ya **sınır** olarak sınıflandırılır. Veri yapısı `Map<cell, {interior: areaId[], boundary: areaId[]}>` şeklindedir. İç hücreler doğrudan eşleşme sayılır. Sınır hücrelerinde kesin point-in-polygon kontrolü yapılır. Bellek kullanımı için iç bölgelerde `compactCells` kullanılabilir.
- **`isUniformCell`:** H3 hücresinin poligonu, bbox'ı kesişen her aday alan için ya tamamen içeride (`booleanWithin`) ya tamamen dışarıda (`booleanDisjoint`) olmalıdır. Sonuç bir LRU cache'te tutulur ve indeks yeniden kurulduğunda cache temizlenir.
- İki uygulama da **aynı sonucu** vermek zorundadır. Bu, property-based test ile doğrulanır.
### 9.2 Durum geçiş fonksiyonu (saf)
 
```ts
type StateRow = { areaId: string; enteredAt: Date; lastInsideAt: Date; outsideCount: number; firstOutsideAt: Date | null };
 
function transition(
  prev: StateRow[],
  point: { ts: Date },
  matchedAreaIds: string[],
  cfg: { exitConfirmPoints: number; exitConfirmMs: number; stateRefreshMs: number },
): {
  entries: { areaId: string; enteredAt: Date }[];
  exits:   { areaId: string; enteredAt: Date; exitedAt: Date }[];
  upserts: StateRow[];     // değişen satırlar
  deletes: string[];       // silinen areaId'ler
}
```
 
Kurallar:
1. `matched` içinde olup `prev` içinde olmayan bir alan varsa: **giriş** kaydı oluştur (`enteredAt = point.ts`) ve yeni bir state satırı ekle.
2. `matched` içinde olup `prev` içinde de olan bir alan için:
   - `outsideCount > 0` ise sayaçları sıfırla (kullanıcı geri döndü, yeni giriş kaydı **oluşmaz**) ve satırı upsert et.
   - Aksi halde `point.ts - lastInsideAt >= stateRefreshMs` ise `lastInsideAt`'i güncelle ve upsert et. Değilse **hiçbir şey yazma**.
3. `prev` içinde olup `matched` içinde olmayan bir alan için:
   - `outsideCount += 1`. `firstOutsideAt` boşsa `point.ts` ile doldur.
   - `outsideCount >= exitConfirmPoints` **veya** `point.ts - firstOutsideAt >= exitConfirmMs` ise **çıkış** kaydı oluştur (`exitedAt = firstOutsideAt`, `exit_reason = 'left'`) ve satırı sil.
   - Aksi halde satırı upsert et.
4. Aynı kullanıcının bir batch'teki noktaları ts sırasıyla işlenir. Her çağrının çıktısı bir sonraki çağrının `prev` girdisi olur.
 
### 9.3 Sabit kullanıcı için atlama kuralı
 
Bir nokta, şu koşulların **hepsi** sağlanırsa tam değerlendirmeye girmeden atlanır:
- `cell = latLngToCell(lat, lng, H3_SKIP_RESOLUTION)` değeri Redis'teki `cell` ile aynı.
- `isUniformCell(cell) === true`.
- Redis'teki `stable === 1` (bekleyen bir çıkış yok, yani tüm `outsideCount` değerleri 0).
- `ts - evalTs < FORCE_EVAL_MS`.
Atlanan noktada sadece Redis filtresindeki `ts` güncellenir.
 
### 9.4 Redis filtre script'i (monoton güncelleme)
 
```lua
-- KEYS[1] = {u:<id>}:f
-- ARGV: ts, cell, evalTs ('' = değiştirme), stable ('' = değiştirme), ttl
local cur = tonumber(redis.call('HGET', KEYS[1], 'ts') or '0')
if tonumber(ARGV[1]) <= cur then return 0 end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'cell', ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'evalTs', ARGV[3]) end
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'stable', ARGV[4]) end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
```
 
---
 
## 10. Fazlar
 
### Faz 0: Kararlar ve dokümantasyon iskeleti
 
**Adımlar**
- 0.1. README iskeletini oluştur. Başlıklar: Genel bakış, Mimari, Kurulum, API, Teknoloji seçimleri, Varsayımlar, Tutarlılık garantileri, Test ve performans, Kapsam dışı, Ölçekleme yolu.
- 0.2. `docs/adr/` altında ilk ADR'leri yaz: PostGIS, TypeORM, Redis Streams, PG'nin asıl kaynak olması, HTTP'nin WebSocket'e tercih edilmesi.
**Neden:** Case gerekçeleri açıkça istiyor. Kararlar alındığı anda yazılınca gerekçeler kaybolmuyor.
 
**Kabul kriteri:** README başlıkları ve en az 5 ADR mevcut.
 
---
 
### Faz 1: Proje iskeleti
 
**Adımlar**
- 1.1. NestJS projesini kur. İki giriş noktası (`main.api.ts`, `main.worker.ts`) ve iki root modül oluştur.
- 1.2. Config modülünü şema doğrulamalı kur. Bölüm 6'daki değişkenleri ve aralarındaki kuralları doğrula.
- 1.3. Docker Compose dosyasını hazırla: `postgis/postgis:16-3.4`, `redis:7`, `api`, `worker` servisleri, healthcheck'ler ve migration'ları çalıştıran bir init adımı.
- 1.4. Multi-stage Dockerfile yaz: production imajında sadece runtime bağımlılıkları olsun ve uygulama root olmayan bir kullanıcıyla çalışsın.
- 1.5. ESLint, Prettier, TypeScript strict modu ve GitHub Actions'ta bir CI (lint, unit testler, e2e testler) kur.
- 1.6. `nestjs-pino` ile loglamayı kur. Her isteğe bir request id atansın.
**Neden:** API ve worker farklı yük profillerine sahip ve bağımsız ölçeklenmeli. Hatalı config uygulamanın açılışta durmasına yol açmalı. Değerlendiren kişi sistemi tek komutla ayağa kaldırabilmeli.
 
**Kabul kriteri:** `docker compose up` ile tüm servisler healthy duruma geliyor. Eksik bir env değişkeni açılışta anlaşılır bir hatayla durduruyor.
 
---
 
### Faz 2: Veritabanı
 
**Adımlar**
- 2.1. TypeORM'u `synchronize: false` ile kur. Primary ve replica bağlantıları için `replication` ayarı kullanılsın. `DATABASE_READ_URL` boşsa primary kullanılsın.
- 2.2. Bölüm 7'deki şemanın migration'larını yaz: extension'lar, `areas`, `area_set_version_seq`, partition'lı `area_entries` (mevcut ay + 3 ay + DEFAULT partition) ve `user_area_state`.
- 2.3. Entity'leri yaz. `Area.geom` kolonu `geometry` tipinde olacak, GeoJSON ile dönüşüm yapılacak.
- 2.4. Gelecek ayların partition'larını oluşturan idempotent bir bakım komutu yaz (`npm run partitions:ensure`).
**Neden:** `synchronize: true` production'da veri kaybına yol açabilir. GiST indeksi mekânsal sorguları hızlandırıyor. Unique constraint idempotency'nin son savunma hattı. Partition'lar tablo büyüdükçe performansı korumayı ve eski veriyi silmeyi kolaylaştırıyor.
 
**Kabul kriteri:** Migration'lar boş bir veritabanında başarıyla çalışıyor ve geri alınabiliyor. `ST_IsValid` CHECK constraint'i geçersiz bir poligon insert'ini reddediyor.
 
---
 
### Faz 3: Areas modülü
 
**Adımlar**
- 3.1. GeoJSON DTO'sunu ve custom validator'ları yaz: `IsGeoJsonPolygon`, ring'lerin kapalı olması, en az 4 nokta, koordinat aralıkları, nokta sayısı üst sınırı.
- 3.2. Servis katmanında `ST_IsValid` / `ST_IsValidReason` kontrolü yap. Geçersiz poligona `422` dön.
- 3.3. POST /areas: Transaction içinde `nextval('area_set_version_seq')` al, alanı kaydet ve versiyonu `areas.version` alanına yaz. Commit'ten sonra Redis'te `area_set_version` değerini güncelle ve `areas.changed` kanalına yayınla.
- 3.4. GET /areas: Keyset pagination, `bbox` filtresi, `ST_AsGeoJSON` ile dönüşüm, versiyonlu Redis cache ve ETag/304 desteği.
- 3.5. Testleri yaz: geçerli poligon, açık ring, kendini kesen poligon (`422`), delikli poligon, `bbox` filtresi, sayfalama ve cache'in geçersiz kılınması.
**Neden:** Geofence motoru alanlara ihtiyaç duyuyor. Geçersiz poligonu otomatik düzeltmek sessizce yanlış kayıtlara yol açabilir. Versiyon, worker'lar arasındaki tutarlılığı izlemeyi sağlıyor.
 
**Kabul kriteri:** Tüm testler geçiyor ve Swagger'da iki endpoint de belgelenmiş.
 
---
 
### Faz 4: Geofence çekirdeği
 
**Adımlar**
- 4.1. `GeofenceIndex` arayüzünü framework'ten bağımsız, saf TypeScript olarak yaz (Bölüm 9.1).
- 4.2. `RTreeGeofenceIndex` uygulamasını yaz.
- 4.3. Uç durum testlerini yaz: kenar ve köşe üzerindeki noktalar, delikli poligonlar, çakışan ve iç içe alanlar, ince ve uzun poligonlar, hiçbir alana düşmeyen noktalar, boş alan seti.
- 4.4. `H3GeofenceIndex` uygulamasını yaz (iç ve sınır hücre sınıflandırması).
- 4.5. `isUniformCell` fonksiyonunu LRU cache'li olarak yaz.
- 4.6. Property-based test yaz (fast-check): rastgele poligonlar ve noktalar üret, iki uygulamanın `findContaining` sonucu birebir aynı olmalı. Ayrıca `isUniformCell(cell) === true` olan bir hücrenin içinden rastgele seçilen her noktanın aynı sonucu verdiğini doğrula.
- 4.7. `AreaIndexManager` sınıfını yaz: açılışta indeksi yükle, `areas.changed` olayında yeniden kur, ayrıca `AREA_INDEX_REFRESH_MS` aralığıyla versiyonu kontrol et. Yeniden kurma işlemi atomik olmalı: yeni indeks hazırlanır, sonra referans değiştirilir.
**Neden:** Bu modül projenin kalbi ve en çok hata riski taşıyan yer. Saf TypeScript olması milisaniyeler içinde binlerce test çalıştırmayı mümkün kılıyor. İki uygulamanın birbiriyle karşılaştırılması, H3'teki sınır hücresi hatalarını yakalıyor.
 
**Kabul kriteri:** Tüm unit testler ve en az 10.000 örneklemli property testleri geçiyor.
 
---
 
### Faz 5: Kullanıcı durumu
 
**Adımlar**
- 5.1. `transition()` fonksiyonunu Bölüm 9.2'deki kurallara göre saf olarak yaz.
- 5.2. Testlerini yaz: ilk giriş, alanda kalmaya devam etme, sınırda gidip gelme (yeni giriş üretmemeli), sayı eşiğiyle çıkış, süre eşiğiyle çıkış, gerçek çıkıştan sonra tekrar giriş (yeni kayıt üretmeli), çakışan alanlara aynı anda giriş, `stateRefreshMs` davranışı, aynı batch'te ardışık noktalar.
- 5.3. `UserStateRepository` sınıfını yaz: `lockAndLoad(userIds)` metodu `SELECT ... FOR UPDATE` kullanacak. Ayrıca `applyChanges(tx, changes)` metodu yaz. Bu metot toplu `INSERT ... ON CONFLICT DO NOTHING` ile girişleri, `UPDATE` ile çıkışları (`exited_at`, `exit_reason`) yazacak, state satırlarını upsert ve delete edecek.
- 5.4. `RedisFilter` sınıfını yaz: pipeline ile `HGETALL` okuması ve Bölüm 9.4'teki Lua script ile monoton güncelleme. Anahtarlarda hash tag kullanılacak.
- 5.5. Repository ve filtre testlerini gerçek servislerle yaz (testcontainers ile Redis ve PostGIS).
**Neden:** İş kuralları tek bir saf fonksiyonda toplandığı için kapsamlı test edilebiliyor. PG asıl kaynak olduğu için dual write sorunu oluşmuyor. Redis kaybolabilir olarak tasarlandığı için failover durumu bir doğruluk sorununa dönüşmüyor.
 
**Kabul kriteri:** Tüm testler geçiyor. Ayrıca Redis tamamen boşken aynı nokta dizisinin aynı DB sonucunu ürettiği doğrulanmış.
 
---
 
### Faz 6: Ingest (POST /locations)
 
**Adımlar**
- 6.1. Tek nokta ve batch'i kabul eden DTO'yu yaz (Bölüm 8 kuralları).
- 6.2. `Partitioner` yaz: `p = murmurhash(userId) % STREAM_PARTITIONS`.
- 6.3. `IngestService.ingest(points)` metodunu yaz: noktaları partition'a göre grupla, pipeline ile `XADD locations:{p} MAXLEN ~ STREAM_MAXLEN` çalıştır ve kabul edilen nokta sayısını dön. Bu servis ileride WebSocket gateway tarafından da kullanılacak.
- 6.4. Backpressure ekle: Toplam bekleyen mesaj sayısını (`XINFO GROUPS` lag'i) arka planda 1 saniyede bir ölç ve bellekte tut. Eşik aşılırsa `503` ve `Retry-After` dön.
- 6.5. `@nestjs/throttler` ile userId ve IP bazında rate limiting uygula.
- 6.6. E2e testlerini yaz: geçerli nokta, batch, geçersiz koordinat, gelecek tarihli timestamp, backpressure senaryosu.
**Neden:** API sadece doğrulayıp kuyruğa yazdığı için gecikmesi düşük kalıyor ve yatay ölçekleniyor. Batch gönderim istek overhead'ini düşürüyor. Backpressure sayesinde worker'lar geride kaldığında sistem çökmek yerine kontrollü şekilde yavaşlıyor. Partition'lama tek yazar garantisinin temeli.
 
**Kabul kriteri:** Testler geçiyor ve aynı userId'ye ait noktaların hep aynı stream'e gittiği doğrulanmış.
 
---
 
### Faz 7: Worker
 
**Adımlar**
- 7.1. **Partition lease:** Her worker periyodik olarak boştaki partition'ları `SET lease:partition:{p} <workerId> NX PX <ttl>` ile sahiplenmeye çalışır ve sahip olduklarını yeniler. Lease'ler worker'lar arasında dengeli dağıtılmalı: bir worker en fazla `ceil(PARTITIONS / aktif worker sayısı)` partition tutar. Lease'ini kaybeden worker o partition'dan okumayı hemen bırakır.
- 7.2. **Okuma:** Her sahip olunan partition için `XREADGROUP GROUP geofence <workerId> COUNT WORKER_BATCH_SIZE BLOCK WORKER_BLOCK_MS STREAMS locations:{p} >`.
- 7.3. **Batch hazırlığı:** Noktaları kullanıcıya göre grupla ve ts'e göre sırala. Redis filtresini pipeline ile oku. `ts <= filter.ts` olan noktaları ele. Bölüm 9.3'teki atlama kuralını uygula.
- 7.4. **Geofence:** Kalan noktalar için bellekte `findContaining` çalıştır. Batch'in o anki indeks versiyonunu kaydet.
- 7.5. **Tek PG transaction'ı:** İlgili kullanıcıların state satırlarını `lockAndLoad` ile kilitleyip oku. Her kullanıcının noktalarını sırayla `transition()` fonksiyonundan geçir. Sonuçları `applyChanges` ile yaz ve commit et.
- 7.6. **Redis filtresini güncelle:** Commit'ten sonra pipeline ile güncelle. Değerler: tam değerlendirilen noktalar için `ts`, `cell`, `evalTs = ts` ve `stable` (kullanıcının tüm `outsideCount` değerleri 0 ise 1). Atlanan noktalar için sadece `ts` ve `cell`.
- 7.7. **Ack:** Son adım olarak `XACK` gönder.
- 7.8. **Bozuk mesajlar:** Batch transaction'ı başarısız olursa batch'i ikiye bölüp tekrar dene (bisect). Tek bir mesaja inildiğinde ve deneme sayısı `MAX_DELIVERY_ATTEMPTS`'i aştığında mesajı `locations:dlq` stream'ine taşı ve ack'le.
- 7.9. **Takılı mesajlar:** Worker açıldığında ve bir partition'ı yeni sahiplendiğinde `XAUTOCLAIM` ile o partition'daki bekleyen mesajları devral.
- 7.10. **Timeout sweeper:** `SWEEPER_INTERVAL_MS` aralığıyla çalışır ve `pg_try_advisory_lock` ile sadece tek bir instance'ta yürür. `last_inside_at < now - SIGNAL_TIMEOUT_MS` olan state satırlarını batch hâlinde `FOR UPDATE SKIP LOCKED` ile alır. Bu satırlar için çıkış kaydı yazar (`exited_at = last_inside_at`, `exit_reason = 'timeout'`) ve satırları siler.
- 7.11. **Graceful shutdown:** `SIGTERM` geldiğinde yeni okuma durdurulur, elindeki batch tamamlanıp ack'lenir, lease'ler bırakılır ve servis kapanır.
**Çökme senaryoları (testlerde doğrulanacak):**
 
| Çökme anı | Sonuç |
|---|---|
| Transaction'dan önce | Mesaj tekrar okunur ve baştan işlenir |
| Transaction sırasında | Rollback olur, mesaj tekrar işlenir |
| Commit ile Redis güncellemesi arasında | PG durumu güncel olduğu için fark çıkmaz. Çıksa bile `ON CONFLICT` yakalar |
| Redis güncellemesi ile ack arasında | `ts <= last_ts` filtresi noktayı atlar |
 
**Neden:** Partition lease tek yazar garantisini sağlıyor. Yazma sırası (önce PG transaction'ı, sonra Redis, en son ack) her çökme anında doğruluğu koruyor. Bisect ve DLQ, tek bir bozuk mesajın tüm kuyruğu kilitlemesini engelliyor. Sweeper, sinyali kesilen kullanıcıların alanlarda sonsuza kadar "içeride" kalmasını önlüyor.
 
**Kabul kriteri:** Uçtan uca senaryo testleri geçiyor: alan oluşturuluyor, dışarıdan içeriye noktalar gönderiliyor ve giriş kaydı oluşuyor. Sınırda gidip gelen noktalar tek bir giriş kaydı üretiyor. Sinyal kesildiğinde timeout ile çıkış oluşuyor.
 
---
 
### Faz 8: Logs (GET /logs)
 
**Adımlar**
- 8.1. Filtreler (`userId`, `areaId`, `from`, `to`) ve `(entered_at, id)` keyset pagination ile sorguyu yaz. Okuma replikadan yapılacak.
- 8.2. `from` ve `to` verildiğinde partition pruning'in çalıştığını `EXPLAIN` ile doğrula. Bir aralık verilmediyse varsayılan olarak son 30 günü sorgula ve bunu dokümante et.
- 8.3. E2e testlerini yaz.
**Neden:** `OFFSET` ile sayfalama tablo büyüdükçe yavaşlar. Varsayılan zaman aralığı, tüm partition'ların taranmasını önlüyor.
 
**Kabul kriteri:** Testler geçiyor ve 1 milyon kayıtlık seed verisinde sayfa sorgusu 50 ms'nin altında.
 
---
 
### Faz 9: Gözlemlenebilirlik
 
**Adımlar**
- 9.1. Prometheus metriklerini ekle:
  - `locations_ingested_total`
  - `locations_rejected_total{reason}`
  - `stream_pending_messages{partition}`
  - `worker_batch_duration_seconds` (histogram)
  - `worker_points_processed_total{result="evaluated|skipped|stale"}`
  - `area_entries_created_total`
  - `area_exits_total{reason}`
  - `dlq_messages_total`
  - `geofence_index_version`
  - `partition_leases_held`
- 9.2. Health endpoint'leri: liveness sadece süreç kontrolü yapar. Readiness DB ve Redis'i kontrol eder, worker'da buna ek olarak indeksin yüklenmiş olmasını şart koşar.
- 9.3. Swagger dokümantasyonunu örnek isteklerle tamamla.
**Neden:** Ölçekleme kararını kuyruk lag'i verir. `skipped` oranı sabit kullanıcı optimizasyonunun etkisini gösterir. Readiness kontrolü, Kubernetes'in hazır olmayan bir pod'a trafik göndermesini engeller.
 
**Kabul kriteri:** `/metrics` endpoint'i tüm metrikleri sunuyor.
 
---
 
### Faz 10: Test ve performans
 
**Adımlar**
- 10.1. **E2E:** Uçtan uca senaryolar. Aynı noktanın tekrar gönderilmesi ve sırası karışmış noktalar çift kayıt üretmemeli.
- 10.2. **Çökme testleri:** Worker'a sadece test ortamında aktif olan fault injection noktaları ekle (Faz 7 tablosundaki her adım için). Her noktada hata fırlat, mesajın tekrar işlenmesinden sonra veritabanının beklenen son durumla birebir aynı olduğunu doğrula.
- 10.3. **Eşzamanlılık testi:** Aynı partition'ı iki worker'a aynı anda işlet (zombi senaryosu). Çift giriş kaydı oluşmamalı.
- 10.4. **Redis kaybı testi:** İşlem ortasında `FLUSHALL` çalıştır. Son durum değişmemeli.
- 10.5. **Atlama doğruluğu:** "Atla" kararı verilen her durumda tam değerlendirmenin de aynı sonucu verdiğini property-based testle doğrula.
- 10.6. **Yük testi (k6):** Kademeli olarak 2.000, 10.000 ve 20.000 nokta/sn hedefle. p95/p99 API gecikmesini, kuyruk lag'ini ve worker throughput'unu ölç. Sonuçları README'ye tablo olarak ekle.
- 10.7. **Benchmark:** R-tree ve H3'ü 100, 1.000 ve 10.000 alan için karşılaştır (nokta/sn ve bellek kullanımı). Sonuçları README'ye ekle ve varsayılan indeks seçimini bu sonuçlara göre gerekçelendir.
**Neden:** "Race condition'ları çözdüm" ve "ölçeklenir" iddialarını kanıtlayan kısım bu testler.
 
**Kabul kriteri:** Tüm testler CI'da geçiyor. Yük testi ve benchmark sonuçları README'de yer alıyor.
 
---
 
### Faz 11: README'nin tamamlanması
 
İçermesi gerekenler:
- Mimari diyagram ve veri akışı
- Tek komutla kurulum (`docker compose up`), örnek `curl` istekleri
- Teknoloji seçimleri ve gerekçeleri (Bölüm 3)
- Varsayımlar (Bölüm 2)
- Tutarlılık garantileri: at-least-once işleme, idempotency, yazma sırası ve çökme tablosu, Redis'in kaybedilebilir olması
- **İstemci sözleşmesi:** Mobil uygulama 10–20 metrelik bir mesafe filtresi kullanmalı, araç durduğunda bile 60 saniyede bir heartbeat göndermeli ve bağlantı kesildiğinde noktaları biriktirip batch hâlinde göndermeli. Heartbeat aralığı ile `SIGNAL_TIMEOUT_MS` arasındaki ilişki açıklanmalı.
- Test ve performans sonuçları
- **Kapsam dışı bırakılanlar:** auth, alan güncelleme ve silme (`area_deleted` çıkış nedeni şemada hazır), alan versiyonlama detayları, ham konum arşivi, antimeridyen desteği, çok bölgeli (multi-region) kurulum
- **Ölçekleme yolu:**
  - Kafka'ya geçiş (userId partition key ile)
  - H3 tabanlı coğrafi sharding (worker'lar sadece kendi bölgelerinin alanlarını yükler)
  - Citus ile veritabanını `user_id` üzerinden shard'lama
  - Ham konumların TimescaleDB veya S3'e (Parquet) ayrı bir consumer ile arşivlenmesi
  - WebSocket veya MQTT ile ek giriş kanalları
---
 
### Faz 12: Bonus (opsiyonel)
 
- 12.1. `LocationsGateway` (WebSocket) yaz. Aynı `IngestService`'i kullansın ve ack olarak kabul edilen nokta sayısını dönsün.
- 12.2. Alanları ve canlı girişleri harita üzerinde gösteren basit bir demo sayfası (Leaflet) ekle.
**Neden:** Mimarinin farklı giriş kanallarına açık olduğunu gösteriyor. Idempotency zaten çözüldüğü için ek bir risk getirmiyor.
 
---
 
## 11. Öncelik özeti
 
| Öncelik | Fazlar |
|---|---|
| Zorunlu (case'i eksiksiz karşılar) | 0–8 |
| Production seviyesi | 9, 10, 11 |
| Fark yaratan | H3 (4.4–4.6), atlama optimizasyonu (9.3), Faz 12 |
 
Zaman daralırsa "fark yaratan" maddeler implement edilmek yerine README'de tasarım olarak anlatılabilir. Bu durumda `GEOFENCE_INDEX=rtree` varsayılan olarak kalır. Atlama optimizasyonu kapatılır, yani her nokta tam değerlendirilir.