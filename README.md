# Location Tracking Service

Location Tracking Service, mobil istemcilerden gelen konumları geofence alanlarıyla karşılaştırarak kullanıcı giriş ve çıkışlarını kaydeder. Uygulama, [plan.md](plan.md) içinde tanımlanan mimari ve fazlar doğrultusunda geliştirilmektedir.

## Genel Bakış

Sistem her konumu kalıcı veritabanına yazmak yerine yalnızca alan durumundaki değişiklikleri saklar. API konumları doğrular ve kuyruğa ekler; worker'lar bu konumları geofence indeksinde değerlendirir.

## Mimari

NestJS API ve worker aynı kod tabanından ama **ayrı süreçler** olarak çalışır (`main.api.ts` / `main.worker.ts`). API hiçbir zaman geofence hesabı yapmaz; sadece doğrular ve kuyruklar. Worker hiçbir zaman HTTP isteği almaz; sadece kuyruğu tüketir.

```
Mobil istemci
  │  POST /locations (tek konum veya {locations:[...]} batch)
  ▼
============================  API SÜRECİ  ============================
  LocationsController
    1. rate limit (ip + user, @nestjs/throttler)
    2. parseLocationRequest → doğrulama (class-validator)
    3. backpressure kontrolü (kuyruk çok doluysa 503)
========================================================================
  │  XADD  (partition = hash(userId) % STREAM_PARTITIONS)
  ▼
Redis Streams: locations:0 … locations:{N-1}
  │  XREADGROUP (consumer group "geofence")
  ▼
============================ WORKER SÜRECİ ============================
  PartitionLeaseService   — SET NX PX ile partition'ları worker'lar
                             arasında paylaştırır
  StreamConsumerService   — sahip olunan her partition için okuma
                             döngüsü; XAUTOCLAIM ile takılı mesajları
                             devralır
    └─ BatchProcessorService, her batch için:
         1. Redis filtresinden atlama kararı (Bölüm 9.3)
         2. AreaIndexManager.findContaining (bellekte R-tree/H3)
         3. transition() — saf durum makinesi
         4. TEK PG transaction: area_entries + user_area_state
         5. Redis filtresi güncelle → en son XACK
       (hata → bisect + tekrar dene; tek mesaj kalıp
        MAX_DELIVERY_ATTEMPTS aşılırsa → locations:dlq)
  TimeoutSweeperService   — periyodik, tek instance (pg_try_advisory_lock);
                             sinyali kesilen kullanıcıları
                             exit_reason='timeout' ile kapatır
========================================================================
  ▼
PostgreSQL / PostGIS  (asıl doğruluk kaynağı)
  areas · area_entries · user_area_state

AreasController (API) --POST/GET /areas--> areas tablosu
  │
  └--pub/sub "areas.changed"--> AreaIndexManager (worker, bellek içi indeks)
                                 (+ periyodik AREA_INDEX_REFRESH_MS yoklaması)
```

**Veri akışı, adım adım:**
1. İstemci bir veya birden çok konum gönderir; API doğrular, `userId`'ye göre sabit bir partition'a yönlendirip Redis Stream'e yazar ve hemen `202` döner (işleme asenkron).
2. Worker, lease'ini tuttuğu her partition'dan batch okur, kullanıcıya göre gruplar, ts'e göre sıralar.
3. Her nokta için önce Redis'teki ucuz filtre (`ts`, `cell`, `stable`) kontrol edilir: aynı "uniform" H3 hücresindeyse ve kullanıcı durumu kararlıysa, tam değerlendirme atlanır (sadece filtre güncellenir).
4. Atlanmayan noktalar bellekteki geofence indeksinde (`findContaining`) değerlendirilir; sonuç saf `transition()` fonksiyonuna, oradan **tek bir PostgreSQL transaction'ına** gider.
5. Commit'ten sonra Redis filtresi güncellenir, en son adım olarak mesaj `XACK`'lenir — bu sıra (PG → Redis → ack), herhangi bir adımda çökme olsa bile tekrar işlemenin güvenli olmasını sağlar (bkz. Tutarlılık Garantileri'ndeki çökme tablosu).
6. Yeni bir alan oluşturulduğunda (`POST /areas`), API hem veritabanına yazar hem de Redis pub/sub ile `areas.changed` yayınlar; her worker'ın `AreaIndexManager`'ı bunu dinler ve bellekteki indeksi yeniden kurar (yayın kaçırılsa da `AREA_INDEX_REFRESH_MS` periyodik yoklaması en fazla bu süre kadar gecikmeyle yakalar).
7. Sinyali kesilen (yeni nokta gelmeyen) kullanıcılar sonsuza dek "içeride" kalmasın diye `TimeoutSweeperService` periyodik olarak `last_inside_at`'i `SIGNAL_TIMEOUT_MS`'i aşan durumları `exit_reason='timeout'` ile kapatır.

R-tree ve H3 geofence indeksleri ortak bir arayüzü (`GeofenceIndex`) uygular; aralarındaki farklar ve ölçüm sonuçları aşağıdaki "Benchmark" bölümünde.

## Kurulum

Node.js 24 ve Docker Compose gereklidir. Compose varsayılan ayarlarla çalışır; değerleri değiştirmek için `.env.example` dosyasını `.env` olarak kopyalayıp düzenleyin.

```sh
docker compose up --build
```

API `http://localhost:3000`, worker sağlık servisi `http://localhost:9100` adresinde başlar. Compose, API ve worker'dan önce tek seferlik migration init servisiyle veritabanı şemasını hazırlar.

Yerel doğrulama komutları:

```sh
npm ci
npm run lint
npm test
```

Veritabanı migration'larını elle uygulamak veya geri almak ve aylık partition'ları tamamlamak için:

```sh
npm run migration:run
npm run migration:revert
npm run partitions:ensure
```

Bu komutları Compose dışında çalıştırırken `.env` içindeki `DATABASE_URL` ve `DATABASE_READ_URL` host erişimine uygun olmalıdır; yerel Docker PostgreSQL'i için host `localhost` kullanılır. PostGIS migration testleri gerçek servis için Docker gerektirir.

## API

HTTP uç noktaları:

- `POST /locations`: Tek konum veya batch konum kabul eder. Batch'teki her nokta bağımsız doğrulanır ve kabul edilir (kısmi kabul) — bkz. örnekler ve İstemci Sözleşmesi.
- `POST /areas`: GeoJSON Polygon alanı oluşturur.
- `GET /areas`: Alanları filtreleyip sayfalar.
- `GET /logs`: Giriş/çıkış kayıtlarını filtreleyip sayfalar.
- `GET /health/live` ve `GET /health/ready`: Süreç ve bağımlılık sağlık kontrolleri.
- `GET /metrics`: Prometheus metrikleri.
- `GET /docs`: Swagger API dokümantasyonu.

### Örnek istekler

`timestamp`, isteğin anında üretilmeli — `TS_MAX_FUTURE_MS` varsayılanı sadece 60 saniye olduğundan, aşağıdaki örneklerdeki gibi sabit bir tarih yapıştırmak (kopyalandıktan bir süre sonra) `400` ile reddedilir:

```sh
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Bir geofence alanı oluştur (GeoJSON Polygon, kapalı ring)
curl -X POST http://localhost:3000/areas \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "kadikoy-merkez",
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[29.02,40.98],[29.04,40.98],[29.04,41.00],[29.02,41.00],[29.02,40.98]]]
    }
  }'

# Tek konum gönder
curl -X POST http://localhost:3000/locations \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"user-1\",\"latitude\":40.99,\"longitude\":29.03,\"timestamp\":\"$NOW\"}"

# Batch konum gönder (MAX_BATCH_LOCATIONS'a kadar). İkinci nokta kasıtlı geçersiz (latitude
# aralık dışı) — yanıt yine de 202 ve accepted:1 döner; geçerli nokta işlenir, geçersiz olan
# "rejected" listesinde index'iyle bildirilir. Hepsi geçersiz olsaydı 400 dönerdi.
curl -X POST http://localhost:3000/locations \
  -H 'Content-Type: application/json' \
  -d "{\"locations\":[
    {\"userId\":\"user-1\",\"latitude\":40.99,\"longitude\":29.03,\"timestamp\":\"$NOW\"},
    {\"userId\":\"user-2\",\"latitude\":99,\"longitude\":29.05,\"timestamp\":\"$NOW\"}
  ]}"
# -> {"accepted":1,"rejected":[{"index":1,"field":"latitude","messages":["latitude must not be greater than 90"]}]}

# Alanları bbox ile filtrele
curl 'http://localhost:3000/areas?bbox=29,40.9,29.1,41.1&limit=20'

# Bir kullanıcının giriş/çıkış geçmişi
curl 'http://localhost:3000/logs?userId=user-1&from=2026-11-01T00:00:00.000Z'
```

`POST /areas` kapalı ring'leri, `[lng, lat]` aralığını ve `MAX_POLYGON_VERTICES` sınırını doğrular; geçersiz geometri `422` ve `ST_IsValidReason` açıklaması döndürür. `GET /areas` `limit`, opak keyset `cursor` ve `bbox=minLng,minLat,maxLng,maxLat` kabul eder; alan sürümüne göre ETag üretir ve eşleşen `If-None-Match` için `304` döndürür. İki endpoint Swagger arayüzünde `http://localhost:3000/docs` adresinde belgelenir.

## Teknoloji Seçimleri

Zorunlu yığın (case gereksinimi): **NestJS**, **TypeScript**, **PostgreSQL**, **TypeORM**. Aşağıdakiler, ihtiyaç duyulduğu için eklenen ek teknolojiler ve gerekçeleri:

- **NestJS ve TypeScript:** API ve worker için ortak, modüler kod tabanı.
- **PostgreSQL ve PostGIS:** Geometrilerin doğrulanması ve mekânsal sorgular.
- **TypeORM:** Native PostGIS geometry desteği ve migration tabanlı şema yönetimi. (Prisma'da PostGIS `geometry` tipi `Unsupported` kalır, her işlem ham SQL gerektirir.)
- **Redis Streams:** Partition'lı kuyruklar, consumer group ve ack desteği — ayrı bir mesajlaşma altyapısı (Kafka, BullMQ) gerektirmeden at-least-once işleme ve crash recovery sağlıyor.
- **Redis:** Kullanıcı başına atlama filtresi, partition lease (dağıtık tek-sahiplik) ve `areas.changed` pub/sub bildirimi — hiçbiri doğruluk için gerekli değil, hepsi kaybedilebilir.
- **Flatbush, Turf ve H3:** Bellek içi geofence aday arama (R-tree) ve kesin geometri değerlendirmesi; H3 ayrıca sabit-kullanıcı atlama optimizasyonu için hücre-uniform'luk kontrolünde kullanılıyor.
- **class-validator ve class-transformer:** DTO doğrulama ve dönüşümü — NestJS'in standart, dekoratör tabanlı yaklaşımı; kurallar controller kodundan ayrı, test edilebilir DTO sınıflarında tutuluyor.
- **Joi:** Ortam değişkeni (env) şema doğrulaması — uygulama geçersiz/eksik bir `.env` ile veya mantıksal olarak tutarsız süre ayarlarıyla (örn. `FORCE_EVAL_MS >= STATE_REFRESH_MS`) **açılmamalı**; bu kontrol açılışta yapılıyor.
- **@nestjs/throttler:** Per-IP ve per-user rate limiting — aşırı/kötü niyetli trafiği API katmanında, worker'a hiç ulaşmadan sınırlıyor.
- **@nestjs/terminus:** `/health/live` ve `/health/ready` — Kubernetes'in henüz hazır olmayan bir pod'a trafik göndermesini engelliyor.
- **prom-client (Prometheus):** Kuyruk lag'i, worker batch süresi, atlanan/değerlendirilen nokta oranı gibi amaca özel 10 metrik — ölçekleme kararı tahminle değil ölçümle verilmeli.
- **nestjs-pino:** Yapılandırılmış (JSON) loglama, her isteğe bir request id — production'da log arama ve korelasyon için düz `console.log`'dan daha uygun.
- **@nestjs/swagger:** `/docs`'ta canlı API dokümantasyonu; her parametre açıklaması ve hata örneği gerçek sunucu cevaplarıyla karşılaştırılarak doğrulandı.
- **lru-cache:** `isUniformCell` sonuçlarının cache'lenmesi (Bölüm 9.1) — aynı H3 hücresi için poligon-kesişim hesabı tekrarlanmıyor; indeks yeniden kurulduğunda cache temizleniyor.
- **murmurhash-js:** `userId → partition` hash'i — hızlı, deterministik, kriptografik olmayan bir hash; aynı kullanıcı her zaman aynı partition'a (ve dolayısıyla aynı worker'a) gider.
- **Docker ve Docker Compose:** Tek komutla (`docker compose up`) tekrarlanabilir ortam — `postgres`, `redis`, `api`, `worker` servisleri ve bunlardan önce çalışıp bitmesi gereken tek-seferlik `migration-init` servisi.
- **Jest, Supertest, testcontainers, fast-check ve k6:** Unit, entegrasyon, property-based, e2e ve yük testleri. Testcontainers ile Redis ve PostGIS **mock'lanmıyor** — gerçek servislere karşı çalışıyor.

Kararların gerekçeleri [docs/adr/](docs/adr/) altında da kayıtlıdır.

## Varsayımlar

- `userId` istek gövdesinden gelir ve güvenilir kabul edilir; kimlik doğrulama kapsam dışıdır.
- İstemci timestamp'i ISO-8601 UTC biçimindedir; giriş/çıkış zamanları bu timestamp'e dayanır.
- Alanlar şehir veya mahalle ölçeğindedir; SRID 4326 kullanılır ve antimeridyen kesişimleri desteklenmez.
- Alanlar çakışabilir; kullanıcı aynı anda birden fazla alanın içinde olabilir.
- Poligon kenarındaki noktalar içeride kabul edilir (`ST_Covers` semantiği).
- Bir kullanıcı gerçekten çıktıktan sonra tekrar girerse yeni giriş kaydı oluşturulur.
- İşleme at-least-once'dur; idempotency tekrar işlemeyi çift kayda dönüştürmez.
- `GET /logs` replika üzerinden eventual consistency ile okuyabilir.

## Tutarlılık Garantileri

- **At-least-once işleme:** Redis Streams consumer group, bir mesajı ack'lenene kadar tekrar tekrar teslim edebilir (worker çökmesi, redelivery, bisect-retry). Sistem bunu *önlemeye* çalışmaz — bunun yerine her tekrar işlemenin **idempotent** (sonucu değiştirmeyen) olmasını garanti eder.
- **Idempotency:** `area_entries`'in `(user_id, area_id, entered_at)` üzerindeki unique kısıtı ve `ON CONFLICT DO NOTHING`, aynı girişin iki kez yazılmasını DB seviyesinde engeller. `user_area_state` zaten bir upsert'tür (PK: `user_id, area_id`). Redis'teki `ts <= filter.ts` kontrolü ise daha önce tam değerlendirilmiş bir noktanın tekrar işlenmesini en başta engeller.
- **Yazma sırası, her zaman aynı:** (1) PostgreSQL transaction (entry/exit + state) commit edilir → (2) Redis filtresi güncellenir → (3) mesaj `XACK`'lenir. Bu sıra kasıtlı: PG her zaman en güncel/asıl kaynak, Redis sadece bir optimizasyon katmanı, ack en son adım.
- **Çökme anı → sonuç tablosu** (worker'ın herhangi bir noktada durup yeniden başladığını varsayarsak; `src/worker/crash-recovery.e2e-spec.ts` ile her satır ayrı test edilir):

  | Çökme anı | Sonuç |
  |---|---|
  | Transaction'dan önce | Mesaj tekrar okunur ve baştan işlenir — hiçbir yan etki henüz oluşmamıştı. |
  | Transaction sırasında | PostgreSQL rollback yapar; mesaj tekrar işlenir, baştan temiz başlar. |
  | Commit ile Redis güncellemesi arasında | PG durumu zaten güncel. Tekrar çalıştırmada `transition()` aynı sonucu üretmez (alan zaten `prev`'te); üretse de `ON CONFLICT` yakalar. |
  | Redis güncellemesi ile ack arasında | Redis'teki `ts` zaten ilerletilmiş; tekrar teslimde `ts <= filter.ts` noktayı baştan atlar, hiç işlenmez. |

- **Redis kaybedilebilir:** Redis sadece kuyruk, partition lease'i ve bir performans optimizasyonu (staleness filtresi) için kullanılır — hiçbiri doğruluk için gerekli değil. `FLUSHALL` sonrası işleme otomatik iyileşir (`src/worker/redis-loss.e2e-spec.ts`); bekleyen Redis Stream mesajları kaybolursa sadece o kuyruktaki konumlar işlenemez (API'nin kendisi veriyi kalıcı başka bir yere yazmadığı için — bu, Redis Streams'i kuyruk olarak seçmenin kapsam dışı bıraktığı bir risktir, bkz. Kapsam Dışı).
- Kullanıcı konumları her zaman aynı partition'a yönlendirilir (partition = hash(userId) % STREAM_PARTITIONS) ve bir partition içinde kullanıcı başına timestamp'e göre sıralı/monoton işlenir.

## İstemci Sözleşmesi

Sunucu tarafı bu üç davranışı **varsayar**; mobil istemci bunlara uymazsa giriş/çıkış tespiti bozulur (ne eksik kalır ne de çift kayıt — ama zamanlaması yanlış olur):

1. **Mesafe filtresi (10–20 m):** İstemci, konum sağlayıcısından gelen her güncellemeyi değil, **en az 10–20 metre hareket ettiğinde** bir nokta göndermeli. Bunun altı: (a) sunucu zaten `H3_SKIP_RESOLUTION` hücresi + `FORCE_EVAL_MS` ile kendi atlama optimizasyonunu yapıyor, aşırı sık/gereksiz nokta bant genişliğini ve worker CPU'sunu boşa harcar; (b) GPS gürültüsü (birkaç metrelik sapma) mesafe filtresi olmadan sınırda gidip-gelen sahte giriş/çıkış üretme riskini artırır — sunucu tarafında `EXIT_CONFIRM_POINTS`/`EXIT_CONFIRM_MS` bunu zaten yumuşatıyor ama kaynağında azaltmak daha sağlıklı.
2. **Heartbeat (durağanken dahi 60 saniyede bir):** Araç/kullanıcı tamamen dursa bile istemci en az 60 saniyede bir konum göndermeli (aynı koordinatla olsa da). Sunucu bir kullanıcının "içeride" olduğunu bilmek için **düzenli sinyale** ihtiyaç duyar; sinyal tamamen kesilirse `TimeoutSweeperService` bunu `exit_reason='timeout'` ile kapatır.
3. **Bağlantı kesintisinde biriktir, sonra batch gönder:** İstemci offline kaldığında konumları yerelde biriktirmeli ve bağlantı geri geldiğinde `{"locations":[...]}` formatında (zaman sırasına göre, `MAX_BATCH_LOCATIONS` sınırına kadar) tek seferde göndermeli. Worker, bir batch içindeki noktaları `ts`'e göre sıralayıp sırayla işler — bu yüzden gönderim sırası değil **`timestamp` alanının doğruluğu** önemlidir. Noktalar birbirinden **bağımsız** kabul edilir: bir batch'teki tek bir geçersiz nokta diğerlerini düşürmez (`POST /locations` kısmi kabul eder — bkz. API bölümü), ama istemci bunu görebilmek için response'daki `rejected` listesini kontrol etmeli; sadece `202` almak her noktanın işlendiği anlamına gelmez.

**Heartbeat aralığı ↔ `SIGNAL_TIMEOUT_MS` ilişkisi:** Varsayılan `SIGNAL_TIMEOUT_MS=600000` (10 dakika), önerilen 60 saniyelik heartbeat'in **10 katı**. Bu geniş pay kasıtlı: ağ gecikmesi, tek bir kayıp paket veya istemcinin heartbeat'i bir-iki tur kaçırması, kullanıcıyı yanlışlıkla "çıktı" olarak işaretlemeyecek. Heartbeat aralığı bu oranın (örn. 1:10) çok üzerine çıkarsa (örn. heartbeat 5 dakikaya uzatılırsa ama `SIGNAL_TIMEOUT_MS` 10 dakikada kalırsa), normal ağ jitter'ı bile sahte timeout-çıkışlarına yol açabilir; dolayısıyla ikisi birlikte ayarlanmalı.

## Test ve Performans

İş kuralları unit testlerle, Redis ve PostGIS etkileşimleri testcontainers ile gerçek servislere karşı doğrulanır (mock yok). Geofence uygulamaları (R-tree/H3) fast-check ile property-based testlerle karşılaştırılır. Worker'ın çökme/eşzamanlılık garantileri ayrı e2e testlerle kanıtlanır:

- **Çökme testleri** (`src/worker/crash-recovery.e2e-spec.ts`): Bölüm 7'nin çökme tablosundaki her satır için (transaction'dan önce / sırasında / commit-Redis arası / Redis-ack arası), test ortamına özel bir `FaultInjector` ile o noktada gerçek bir hata fırlatılır; mesajın yeniden teslim edilmesinden sonra veritabanının beklenen son durumla birebir aynı olduğu doğrulanır.
- **Eşzamanlılık testi** (`src/worker/concurrency.e2e-spec.ts`): aynı mesaj, iki bağımsız worker örneğine (ayrı `BatchProcessorService`, ayrı DB bağlantısı) eşzamanlı olarak işletilir; `area_entries`'in `(user_id, area_id, entered_at)` unique kısıtı ve `user_area_state`'in birleşik primary key'i sayesinde tek kayıt oluştuğu doğrulanır.
- **Redis kaybı testi** (`src/worker/redis-loss.e2e-spec.ts`): akış ortasında `FLUSHALL` çalıştırılır (lease'ler, aktif worker seti, kullanıcı filtreleri silinir); işleme kesintisiz sürer ve son durum bozulmaz. Bu test ayrıca gerçek bir hatayı da ortaya çıkardı: `StreamConsumerService`'in tüketim döngüsü beklenmedik bir hatada (örn. stream/grup FLUSHALL ile silindiğinde) sessizce ölüyor ve yalnızca lease kaybedilip yeniden kazanılırsa kendini onarıyordu — bu hiç gerçekleşmezse partition sonsuza dek terk edilmiş kalırdı. Düzeltme: döngü artık lease'i hâlâ elinde tutuyorsa kendini otomatik yeniden başlatıyor.
- **Sırası karışmış noktalar** (`src/worker/worker.e2e-spec.ts`): bir çıkıştan sonra, çıkıştan önceki bir zaman damgasıyla gelen "gecikmeli" nokta, Redis filtresinin `ts <= filter.ts` koruması sayesinde hayalet bir giriş kaydı oluşturmuyor.
- **Atlama doğruluğu** (`src/worker/skip-rule.property.spec.ts`): rastgele kullanıcı rotaları, atlama optimizasyonu açık ve kapalıyken ayrı ayrı simüle edilir; üretilen giriş/çıkış kayıtlarının birebir aynı olduğu property-based testle (`fast-check`, 2.000 koşum) kanıtlanır.

### Benchmark: R-tree vs H3 (Faz 10.7)

`benchmarks/geofence-benchmark.ts` ile 100/1.000/10.000 rastgele alan üzerinde ölçüldü (Apple M2, arm64, Node v24.7.0; 50.000 rastgele sorgu noktası/indeks, 3 koşumun medyanı):

| İndeks | Alan sayısı | `rebuild()` süresi | Bellek (heap delta) | Nokta/sn (`findContaining`) |
|---|---|---|---|---|
| R-tree (Flatbush) | 100 | ~7 ms | ~0.8 MB | ~3.9M |
| H3 (çözünürlük 9) | 100 | ~100 ms | ~1.9 MB | ~870K |
| R-tree (Flatbush) | 1.000 | ~8 ms | ~0.9 MB | ~2.5M |
| H3 (çözünürlük 9) | 1.000 | ~460 ms | ~3.4 MB | ~800K |
| R-tree (Flatbush) | 10.000 | ~18 ms | ~2.1 MB | ~1.5M |
| H3 (çözünürlük 9) | 10.000 | ~4.5 s | ~19 MB | ~480K |

**Sonuç:** R-tree, test edilen her ölçekte hem `rebuild()` süresinde hem de sorgu throughput'unda H3'ü büyük farkla geçiyor; H3'ün `rebuild()` maliyeti alan sayısıyla süper-lineer büyüyor (poligon→hücre dönüşümünün maliyeti), R-tree'nin maliyeti ise neredeyse düz kalıyor. Bu, varsayılan `GEOFENCE_INDEX=rtree` seçimini doğruluyor. H3'ün asıl değeri (Bölüm 9.3'teki `isUniformCell` tabanlı atlama kuralı için sınır/iç hücre ayrımı) R-tree'de de aynı arayüz üzerinden mevcut — yani H3'ü seçmek sadece "daha yavaş R-tree" almak anlamına gelmiyor, ama bu projenin alan sayısı ölçeğinde (şehir/mahalle, muhtemelen binlerce alan) R-tree açıkça daha iyi bir varsayılan.

Çalıştırmak için:
```sh
npx tsc benchmarks/geofence-benchmark.ts --outDir .bench-tmp --target ES2022 --module commonjs \
  --esModuleInterop --skipLibCheck --resolveJsonModule --moduleResolution node \
  --experimentalDecorators --emitDecoratorMetadata
node --expose-gc .bench-tmp/benchmarks/geofence-benchmark.js
```

### Yük testi (Faz 10.6)

`benchmarks/load-test.js` (k6) ile `POST /locations`'a 2.000, 10.000 ve 20.000 nokta/sn hedeflendi (20 noktalık batch'ler, `docker compose up` ile ayağa kaldırılan gerçek stack'e karşı, `RATE_LIMIT_PER_MIN` bu ölçüm için yükseltilerek — rate limit tek bir istemciyi değil toplam sistem kapasitesini ölçmeyi engellememesi için).

**Donanım kısıtı — ölçülen tavan, mimarinin değil bu geliştirme makinesinin sınırı:** Bu makinede Docker Desktop'ın Linux VM'i sadece **4 vCPU**'ya sınırlı (host 8 çekirdekli), ve bu 4 vCPU `postgres`+`redis`+`api`+`worker` container'ları arasında paylaşılıyor. Kalibrasyon taraması bunu kanıtlıyor:

| Hedef (nokta/sn) | p95 gecikme | Düşen iterasyon |
|---|---|---|
| 100 | 140 ms | 0 |
| 300 | 465 ms | 0 |
| 500 | 1.08 s | 0 |
| 800 | 1.43 s | 0 |
| 1.200 | 17.9 s | %12 |
| 1.600 | 24.2 s | %31 |
| 2.000 | 15.0 s | %19 |

~800-1.000 nokta/sn'den sonra gecikme aniden patlıyor. Bunun bir kod/mimari sorunu olmadığını doğrulamak için: aynı API kodu Docker **dışında** (yerel `node dist/main.api.js`, aynı dockerize Postgres/Redis'e bağlı) çalıştırıldığında, aynı 2.000 nokta/sn yükünde **p95 = 42.75 ms** ile sorunsuz yanıt verdi — darboğaz container'ların kendisi değil, bu makinedeki Docker Desktop VM'inin CPU tahsisi. Üretimde (veya `cpus: 8` ayarlı bir Docker Desktop'ta) bu tavan ortadan kalkar.

Plan'ın istediği üç resmi hedefin bu kısıtlı donanımdaki ham sonuçları (dürüstçe, iyileştirilmeden):

| Hedef (nokta/sn) | Gerçekleşen istek/sn | p95 gecikme | Başarısız/düşen |
|---|---|---|---|
| 2.000 | ~31/s | 40.6 s | checks: %0 başarısız, ama iterasyonların %54'ü hiç gönderilemedi (`dropped_iterations`) |
| 10.000 | ~48/s | ≥60 s (timeout) | checks: %36 başarısız, iterasyonların %81'i düştü |
| 20.000 | ~50/s | ≥60 s (timeout) | checks: %38 başarısız, iterasyonların %91'i düştü |

Dikkat çekici nokta: 10.000 ve 20.000 hedeflerinde **gerçekleşen istek/sn neredeyse aynı** (~48-50/s) — sistem, istenen hedeften bağımsız olarak aynı donanım tavanına (makinenin 4 vCPU'suyla sınırlı ~800-1.000 nokta/sn) oturuyor. Worker tarafı bu süre boyunca kesintisiz işlemeye devam etti (`worker_points_processed_total{result="evaluated"}` her iki koşumda da sürekli arttı) — yani darboğaz ingest/API tarafında, worker/kuyruk pipeline'ında değil.

Çalıştırmak için (stack ayakta ve en az bir alan oluşturulmuşken):
```sh
RATE_LIMIT_PER_MIN=1000000 docker compose up --build -d
TARGET_POINTS_PER_SEC=2000 BATCH_SIZE=20 RAMP_SEC=10 HOLD_SEC=30 k6 run benchmarks/load-test.js
```

## Kapsam Dışı

- **Kimlik doğrulama:** `userId` istek gövdesinden gelir ve güvenilir kabul edilir.
- **Alan güncelleme ve silme:** Alanlar sadece oluşturulabilir. `exit_reason` enum'ında `area_deleted` değeri şema seviyesinde zaten hazır (bkz. `area_entries.exit_reason` CHECK kısıtı) — ileride silme eklenirse mevcut açık girişleri bu nedenle kapatacak kod yazılması yeterli olur, şema değişikliği gerekmez.
- **Alan versiyonlama detayları:** `areas.version`, `nextval('area_set_version_seq')` ile tek bir monoton sayaçtan gelir ve sadece "indeks bu sürümden sonra mı yeniden kuruldu" sorusuna cevap verir; alanın geçmiş geometrilerini saklayan bir versiyon geçmişi yoktur.
- **Ham konum arşivi:** Konumlar değerlendirildikten sonra saklanmaz; sadece alan durumu değişiklikleri (`area_entries`) kalıcıdır.
- **Antimeridyen desteği:** Alanlar 180./−180. meridyeni kesemez (SRID 4326, şehir/mahalle ölçeği varsayımı).
- **Çok bölgeli (multi-region) kurulum:** Tek PostgreSQL/Redis kümesi varsayılır.

### Faz 12 (bonus, opsiyonel) — uygulanmadı, tasarım notu

WebSocket girişi ve harita demosu bilinçli olarak **uygulanmadı** (plan.md'nin kendi önerisi: zaman kısıtlıysa bu maddeler "tasarım olarak" anlatılabilir). Nasıl yapılacağı:

- **`LocationsGateway` (WebSocket):** `@WebSocketGateway()` ile yeni bir gateway; `@SubscribeMessage('locations')` handler'ı, `LocationsController`'ın bugün kullandığı **aynı** `IngestService.ingest(points)` ve `parseLocationRequest`'i çağırır — ingest mantığı zaten taşıyıcıdan (HTTP/WS) bağımsız tasarlandığı için yeni bir doğrulama/kuyruklama kodu yazmaya gerek kalmaz. Ack olarak `{accepted, rejected}` (bugünkü HTTP response'uyla aynı şekil) WS mesajı olarak geri döner. Idempotency zaten Redis/PG seviyesinde çözüldüğü için (bkz. Tutarlılık Garantileri) bu ek giriş kanalı yeni bir doğruluk riski getirmez.
- **Harita demo sayfası (Leaflet):** Statik bir HTML sayfası; açılışta `GET /areas`'tan poligonları çizer, canlı girişler için ya `GET /logs`'u kısa aralıkla polling yapar ya da `LocationsGateway` üzerinden bir `area.entered` event'i yayınlanıp sayfa buna abone olur. Salt demo amaçlı, API'nin iş mantığına dokunmaz.

## Güvenlik

**Hâlihazırda var olanlar:**
- Docker imajı root olmayan bir kullanıcıyla (`USER node`) çalışıyor.
- Tüm girdi (konum, poligon) sıkı doğrulanıyor: koordinat aralıkları, poligon başına `MAX_POLYGON_VERTICES`, istek başına `MAX_BATCH_LOCATIONS` — büyük/bozuk payload'larla DoS riskini sınırlıyor.
- Per-IP ve per-user rate limiting (`@nestjs/throttler`).
- Tüm sorgular TypeORM'un parametreli sorgu API'si üzerinden gidiyor; hiçbir yerde kullanıcı girdisi ham SQL'e string olarak enjekte edilmiyor.
- Sırlar (`DATABASE_URL`, `REDIS_URL`) `.env`'de tutulur, `.gitignore` ile repoya girmesi engellenir.

**Production'a geçerken eklenecekler (bu case kapsamında bilinçli olarak yapılmadı):**
- **Kimlik doğrulama/yetkilendirme:** `userId` şu an istek gövdesinden gelip güvenilir kabul ediliyor (bkz. Varsayımlar). Production'da JWT doğrulaması + `userId`'nin token'dan alınması, ve `POST /areas` gibi yazma endpoint'lerinin bir admin/rol kontrolünden geçmesi gerekir.
- **Dağıtık rate limiting:** `@nestjs/throttler`'ın varsayılan storage'ı **process-içi bellekte** tutuluyor. API birden fazla instance ile koşarsa (ki mimari tam olarak bunun için tasarlandı), her instance kendi sayacını tutar — efektif limit `RATE_LIMIT_PER_MIN × instance sayısı` olur, tek bir global limit değil. Production'da Redis-backed bir throttler storage'a (`@nestjs/throttler`'ın Redis storage'ı veya benzeri) geçilmeli.
- **Güvenlik header'ları:** `helmet` gibi bir middleware ile CSP, `X-Content-Type-Options`, `X-Frame-Options`, HSTS gibi header'lar eklenmedi.
- **TLS:** `postgres://`/`redis://` bağlantıları şu an düz metin; production'da `sslmode=require` / `rediss://` ve servisler arası mTLS düşünülmeli. TLS terminasyonu zaten bir load balancer/ingress'te yapılacağı varsayılıyor, uygulama kodu bunu kendisi yapmıyor.
- **Sır yönetimi:** Şu an `.env` dosyası; production'da bir secrets manager (Vault, AWS Secrets Manager, Kubernetes Secrets) kullanılmalı.
- **Bağımlılık taraması:** CI'da (`.github/workflows/ci.yml`) `npm audit` veya Dependabot/Snyk gibi bir otomatik tarama yok.
- **En az ayrıcalık (DB):** Migration'lar ve runtime aynı Postgres kullanıcısıyla (`app`) çalışıyor. Production'da migration'lar için ayrı, DDL yetkisi olan bir rol; runtime için sadece gerekli DML izinlerine sahip, DDL yetkisi olmayan ayrı bir rol kullanılmalı.
- **PII / veri saklama politikası:** `userId` ve konum verisi kişisel veri sayılabilir. Production'da şifreleme-at-rest, saklama süresi politikası ve "unutulma hakkı" (kullanıcı verisinin silinmesi) talepleri için bir mekanizma gerekir — şu an `area_entries`'i `userId`'ye göre toplu silen bir endpoint/job yok.

## Ölçekleme Yolu

Planlanan seçenekler: userId partition key ile Kafka'ya geçiş, H3 tabanlı coğrafi worker sharding'i, Citus ile `user_id` üzerinden veritabanı sharding'i, ham konumların TimescaleDB veya S3/Parquet'e arşivlenmesi ve WebSocket/MQTT gibi ek giriş kanalları.