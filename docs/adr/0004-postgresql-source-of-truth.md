# ADR 0004: PostgreSQL asıl doğruluk kaynağıdır

- Durum: Kabul edildi
- Tarih: 2026-11-14

## Bağlam

Konum işleme PostgreSQL ve Redis üzerinde durum tutar. İki sistem arasında atomik transaction olmadığı için yazma sırası ve hata sonrası tekrar işleme doğruluğu korumalıdır.

## Karar

Kalıcılığı gereken alan, kullanıcı durumu ve giriş/çıkış kayıtlarının tek doğruluk kaynağı PostgreSQL olacaktır. Giriş kaydı ile durum değişikliği aynı PostgreSQL transaction'ında yazılır. Redis filtre/cache verisi commit sonrasında güncellenir ve mesaj yalnızca bundan sonra ack edilir.

## Sonuçlar

- Redis yeniden başlatılabilir veya kaybolabilir; kalıcı durum PostgreSQL'den yeniden kurulabilir.
- Tekrar işleme, monoton timestamp kontrolü ve veritabanı unique constraint'leriyle idempotent tutulur.
- `GET /logs` replika üzerinden eventual consistency ile çalışabilir.