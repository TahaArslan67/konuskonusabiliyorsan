# Lingoflow Backend (Proxy)

Express tabanlı bir backend proxy. Amaç: Mobil istemcinin OpenAI Realtime gibi servislerle güvenli biçimde haberleşmesi (API anahtarını istemciye sızdırmadan), oran sınırlama ve kullanım ölçümü.

## Özellikler
- Express + WebSocket (ws)
- CORS, rate limit, logging (morgan)
- Basit oturum akışı: `/session/start`, `/session/close`
- Realtime WS köprüsü: `/realtime/ws` (iskelet; gerçek entegrasyon eklenecek)

## Kurulum

1) Bağımlılıkları kurun
```bash
npm install
```

2) Ortam dosyasını oluşturun
```bash
# Windows PowerShell
Copy-Item .env.example .env
```
`.env` dosyasına kendi `OPENAI_API_KEY` değerinizi girin.

3) Geliştirme modunda başlatın
```bash
npm run dev
```

4) Sağlık kontrolü
`GET http://localhost:8080/health`

## Ortam Değişkenleri
- `PORT` (varsayılan 8080)
- `NODE_ENV` (development/production)
- `ALLOWED_ORIGINS` (virgül ile ayrılmış beyaz liste)
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
- `OPENAI_API_KEY` (istemciye asla göndermeyin)
- `OPENAI_REALTIME_MODEL` (ör: gpt-4o-realtime-preview)

## Yol Haritası
- Realtime API bağlantısı (WebRTC/WS) ve ses akışı
- Kullanım metering ve plan limitleri
- Oturum kapanışında özet/loglama
