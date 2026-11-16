# ADR 0001: Mekânsal veri için PostGIS

- Durum: Kabul edildi
- Tarih: 2026-11-14

## Bağlam

Servis poligon alanlarını saklamalı, geometrilerin geçerliliğini denetlemeli ve bir noktanın alan içinde olup olmadığını doğru biçimde belirlemelidir. Alan sınırları üzerindeki noktalar da içeride sayılmalıdır.

## Karar

Veritabanı PostgreSQL ve PostGIS olacaktır. Alan geometrileri SRID 4326 `geometry(Polygon)` olarak saklanacak; geçerlilik `ST_IsValid`, nokta kapsama semantiği `ST_Covers` ile ele alınacak ve geometri sorguları GiST indeksi kullanacaktır. Geçersiz poligonlar otomatik olarak `ST_MakeValid` ile düzeltilmeyecektir.

## Sonuçlar

- Mekânsal doğrulama ve indeksleme veritabanında tutarlı biçimde uygulanır.
- Uygulama ve test ortamı PostGIS extension'ını desteklemelidir.
- Antimeridyeni kesen poligonlar destek kapsamı dışındadır.