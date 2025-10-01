// Backend taban URL'sini burada konfigüre edebilirsiniz.
// Boş bırakırsanız app.js otomatik olarak aynı origin'i kullanır.
// Örnek: window.__BACKEND_BASE__ = 'https://api.your-backend.com';
// Not: 'api.konuskonusabilirsen.com' DNS'i hazır değilse, aynı origin üzerinden /api çağrıları çalışır.
// Prod'da vercel.json rotaları /api/* isteklerini backend'e yönlendirir.
window.__BACKEND_BASE__ = window.location.origin;
