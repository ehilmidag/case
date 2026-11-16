# ADR 0005: İlk sürümde konum alımı için HTTP

- Durum: Kabul edildi
- Tarih: 2026-11-14

## Bağlam

Mobil istemciler yaklaşık beş saniyede bir konum gönderir. Trafik tek yönlüdür; batch gönderim ve HTTP keep-alive istek overhead'ini azaltabilir. Stateful bağlantılar ilk sürümün işletim ve ölçekleme yükünü artırır.

## Karar

İlk sürümde konum alımı HTTP `POST /locations` ve batch sözleşmesiyle yapılacaktır. WebSocket temel mimariye dahil edilmeyecek; opsiyonel bir giriş kanalı olarak Faz 12'de aynı `IngestService` üzerinden eklenebilir.

## Sonuçlar

- API stateless kalır ve HTTP ile yatay ölçeklenebilir.
- İstemci bağlantı kesintisinde noktaları biriktirip batch gönderebilir.
- Gerçek zamanlı çift yönlü iletişim ihtiyacı ortaya çıkarsa WebSocket kararı ayrıca değerlendirilebilir.