# ADR 0003: Konum kuyruğu olarak Redis Streams

- Durum: Kabul edildi
- Tarih: 2026-11-14

## Bağlam

Konum trafiği veritabanı yazmalarından ayrılmalı, kullanıcı bazında sıralı partition'lanmalı ve worker hatalarında yeniden işlenebilmelidir. Sistem at-least-once teslim garantisi verir.

## Karar

Konumlar `hash(userId) % STREAM_PARTITIONS` ile seçilen Redis Stream'e yazılacaktır. Worker'lar consumer group üzerinden okuyup PostgreSQL işlemi tamamlandıktan sonra mesajı ack edecektir. Redis, kalıcı doğruluk kaynağı değil kuyruk ve filtre/cache altyapısıdır.

## Sonuçlar

- API, konumu kuyruğa ekledikten sonra hızlıca yanıt verebilir.
- Worker'lar partition lease'i, ack, yeniden deneme ve DLQ akışını yönetmelidir.
- Trafik veya işletim gereksinimleri değişirse Kafka'ya geçiş, userId partition key korunarak ölçekleme yolu olarak belgelenmiştir.