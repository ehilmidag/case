# ADR 0002: ORM olarak TypeORM

- Durum: Kabul edildi
- Tarih: 2026-11-14

## Bağlam

Servis PostgreSQL/PostGIS kullanır. Alan geometrilerinin native geometry tipiyle eşlenmesi ve şema değişikliklerinin denetlenebilir migration'larla uygulanması gerekir.

## Karar

ORM olarak TypeORM kullanılacaktır. Şema yönetimi migration'larla yapılacak ve `synchronize` kapalı tutulacaktır. Geometri verileri GeoJSON ile uygulama sınırında dönüştürülecektir.

## Sonuçlar

- PostGIS geometry kolonları uygulamanın veri katmanında native olarak temsil edilir.
- Şema değişiklikleri migration ve rollback ile yönetilir.
- Mekânsal sorgular gerektiğinde açık SQL kullanabilir; otomatik şema eşitlemesine güvenilmez.