import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { toASCII } from 'punycode';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import helmet from 'helmet';
import compression from 'compression';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, Subscription, Usage, Streak, Achievement, Goal, Payment, DailyChallenge } from './models.js';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import Iyzipay from 'iyzipay';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import fs from 'fs';

const app = express();
const server = createServer(app);
// Trust proxy headers (Render/Heroku/Nginx vb.) so rate-limit and req.ip work correctly
// This fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from express-rate-limit
app.set('trust proxy', true);
// Remove X-Powered-By header
app.disable('x-powered-by');

// Env
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const STRICT_REALTIME = String(process.env.STRICT_REALTIME || 'false').toLowerCase() === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hemekonus';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// MongoDB bağlantı ayarları
const mongooseOptions = {
  maxPoolSize: 100,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 30000,
  family: 4,
  retryWrites: true,
  w: 'majority'
};

// MongoDB bağlantısı olayları
mongoose.connection.on('connected', () => {
  console.log('MongoDB bağlantısı başarılı');
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB bağlantı hatası:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB bağlantısı kesildi');
});

// Uygulama kapatılırken bağlantıyı kapat
process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
    console.log('MongoDB bağlantısı kapatıldı');
    process.exit(0);
  } catch (err) {
    console.error('MongoDB bağlantısı kapatılırken hata:', err);
    process.exit(1);
  }
});

// CORS
const allowedOriginsRaw = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// Build a set with both Unicode and punycode (ASCII) origin forms
const allowedOriginsSet = new Set();
for (const o of allowedOriginsRaw) {
  if (!o) continue;
  allowedOriginsSet.add(o);
  try {
    const u = new URL(o);
    const asciiHost = toASCII(u.hostname);
    const normalized = `${u.protocol}//${asciiHost}${u.port ? ':'+u.port : ''}`;
    allowedOriginsSet.add(normalized);
  } catch {}
}

// CORS configuration (lock down to allowed origins if provided)
const corsOptions = {
  origin: function (origin, callback) {
    try {
      if (!origin) return callback(null, true); // non-browser or same-origin

      const o = String(origin).trim();

      // Allow localhost for development
      if (o.startsWith('http://localhost:') || o.startsWith('https://localhost:')) {
        return callback(null, true);
      }

      // Allow all konuskonusabilirsen.com subdomains
      if (o.endsWith('.konuskonusabilirsen.com') || o.endsWith('konuskonusabilirsen.com')) {
        return callback(null, true);
      }

      if (allowedOriginsSet.size === 0) {
        // Fallback defaults (prod web origins)
        const defaults = new Set([
          'https://www.konuskonusabilirsen.com',
          'https://konuskonusabilirsen.com',
          'http://localhost:3000',
          'http://localhost:5173',
          'https://app.konuskonusabilirsen.com',
          'https://admin.konuskonusabilirsen.com'
        ]);
        if (defaults.has(o)) return callback(null, true);
        return callback(null, false);
      }

      if (allowedOriginsSet.has(o)) return callback(null, true);
      return callback(null, false);
    } catch (e) {
      return callback(e);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
// Explicitly handle preflight
app.options('*', cors(corsOptions));

// OCR + Çeviri — Görselleri alır, OpenAI ile metni çıkarıp çevirir (auth + günlük kota)
// Bu uç, büyük görseller için daha yüksek JSON limitine ihtiyaç duyar
app.post('/api/ocr-translate', authRequired, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'server_not_configured', hint: 'OPENAI_API_KEY missing' });

    const { images = [], sourceLang = 'tr', targetLang = 'en' } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'no_images' });
    }
    if (images.length > 10) {
      return res.status(400).json({ error: 'too_many_pages', hint: 'En fazla 10 sayfa/görsel gönderin' });
    }

    // --- Plan bazlı günlük OCR kota kontrolü ---
    const uid = req.auth?.uid;
    const userDoc = await User.findById(uid);
    if (!userDoc) return res.status(401).json({ error: 'unauthorized' });
    const plan = userDoc.plan || 'free';
    const ocrDailyLimit = plan === 'pro' ? 30 : (plan === 'starter' ? 10 : (plan === 'economy' ? 5 : 1));
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    userDoc.ocrUsage = userDoc.ocrUsage || { day: today, count: 0 };
    if (userDoc.ocrUsage.day !== today) { userDoc.ocrUsage.day = today; userDoc.ocrUsage.count = 0; }
    if ((userDoc.ocrUsage.count || 0) >= ocrDailyLimit) {
      return res.status(403).json({ error: 'limit_reached', dailyUsed: userDoc.ocrUsage.count, dailyLimit: ocrDailyLimit });
    }

    // Basit doğrulama: sadece data URL kabul et
    const dataUrlRe = /^data:\s*image\/(png|jpe?g|webp|heic|heif);base64,/i;
    const cleaned = images.filter(u => typeof u === 'string' && dataUrlRe.test(u)).slice(0, 10);
    if (cleaned.length === 0) return res.status(400).json({ error: 'invalid_images' });

    const model = 'gpt-4o-mini';
    const results = [];
    for (let i = 0; i < cleaned.length; i++) {
      const url = cleaned[i];
      // Chat Completions ile multi‑modal: image_url olarak data URL gönderiyoruz
      const payload = {
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are an OCR + translation assistant. Extract text in ${sourceLang.toUpperCase()} precisely (preserve line breaks). Then translate to ${targetLang.toUpperCase()} in a second section. IMPORTANT: The translated text MUST be in ${targetLang.toUpperCase()} only (do NOT use English unless targetLang is EN). Respond in this exact JSON shape without backticks: {"text_tr":"<SOURCE_TEXT>","text_en":"<TRANSLATED_TEXT>"}. NOTE: The key name 'text_en' is legacy; it does NOT imply English. Always put the translation in ${targetLang.toUpperCase()}.`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Extract text in language code "${sourceLang}" and translate to language code "${targetLang}". Output valid JSON with keys text_tr (source text) and text_en (translated text), exactly as instructed.` },
              { type: 'image_url', image_url: { url } }
            ]
          }
        ]
      };

      const fetchImpl = (typeof fetch !== 'undefined') ? fetch : (await import('node-fetch')).default;
      const r = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const txt = await r.text().catch(()=> '');
        return res.status(502).json({ error: 'openai_error', status: r.status, detail: txt });
      }
      const j = await r.json();
      const content = j?.choices?.[0]?.message?.content || '';
      // İçerik saf metin; JSON bekliyoruz
      let parsed = null;
      try { parsed = JSON.parse(content); } catch {}
      if (!parsed || (typeof parsed.text_tr !== 'string' && typeof parsed.text_en !== 'string')) {
        // Model JSON döndürmediyse, hepsini EN çeviri gibi işaretle
        results.push({ page: i+1, text_tr: '', text_en: String(content || '').trim() });
      } else {
        results.push({ page: i+1, text_tr: parsed.text_tr || '', text_en: parsed.text_en || '' });
      }
      // Kısa gecikme (isteğe bağlı, oran sınırlama için)
      await new Promise(r => setTimeout(r, 50));
    }

    const combinedTR = results.map(r => r.text_tr).filter(Boolean).join('\n\n');
    const combinedEN = results.map(r => r.text_en).filter(Boolean).join('\n\n');
    // İşlem başarılıysa sayaç artır ve kaydet
    try {
      userDoc.ocrUsage.count = (userDoc.ocrUsage.count || 0) + 1;
      await userDoc.save();
    } catch (e) { console.warn('[ocr-translate] quota increment failed:', e?.message || e); }
    return res.json({ pages: results, text_tr: combinedTR, text_en: combinedEN, quota: { dailyUsed: userDoc.ocrUsage.count, dailyLimit: ocrDailyLimit } });
  } catch (e) {
    console.error('[ocr-translate] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// STT — Whisper ile ses -> metin (JSON data URL kabul eder)
app.post('/api/stt', authRequired, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'server_not_configured', hint: 'OPENAI_API_KEY missing' });

    const { audio, language = 'tr', durationMs } = req.body || {};
    if (typeof audio !== 'string' || audio.length < 50) {
      return res.status(400).json({ error: 'invalid_audio', hint: 'Send data URL (base64) in body.audio' });
    }
    // data:audio/<mime>;base64,<payload>
    const m = /^data:\s*audio\/(?:[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(audio);
    const mimeMatch = /^data:\s*(audio\/[a-zA-Z0-9+.-]+);base64,/i.exec(audio);
    if (!m || !mimeMatch) {
      return res.status(400).json({ error: 'invalid_audio_format' });
    }
    const b64 = m[1];
    const mime = mimeMatch[1] || 'audio/webm';

    // Kota kontrolü (dakikaya bağlı) — Realtime ile aynı mantık
    const uid = req.auth?.uid;
    const userDoc = await User.findById(uid);
    if (!userDoc) return res.status(401).json({ error: 'unauthorized' });

    // Usage alanlarını hazırla / eksikleri tamamla
    userDoc.usage = userDoc.usage || {};
    const now = new Date();
    // Günlük sıfırlama
    try {
      const lastReset = userDoc.usage.lastReset ? new Date(userDoc.usage.lastReset) : null;
      if (!lastReset || now.toDateString() !== lastReset.toDateString()) {
        userDoc.usage.dailyUsed = 0;
        userDoc.usage.lastReset = now;
      }
    } catch {}
    // Aylık sıfırlama (ay başlangıcını geçince)
    try {
      if (!userDoc.usage.monthlyResetAt) {
        userDoc.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      } else if (now > new Date(userDoc.usage.monthlyResetAt)) {
        userDoc.usage.monthlyUsed = 0;
        userDoc.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      }
    } catch {}
    // Limitleri belirle
    const dailyLimit = userDoc.usage.dailyLimit || getPlanLimit(userDoc.plan || 'free', 'daily');
    const monthlyLimit = userDoc.usage.monthlyLimit || getPlanLimit(userDoc.plan || 'free', 'monthly');
    const usedDaily = Number(userDoc.usage.dailyUsed || 0);
    const usedMonthly = Number(userDoc.usage.monthlyUsed || 0);

    // Bu çağrının tahmini süresi (dk)
    const durMsNum = Math.max(100, Math.min(120000, Number(durationMs) || 7000)); // 0.1s-120s arası, varsayılan 7s
    const callMinutes = Math.max(0.05, Math.round((durMsNum / 60000) * 100) / 100); // 2 ondalık, min 0.05 dk

    // Limit aşımı pre-check (işlem öncesi)
    if (usedDaily + callMinutes > dailyLimit || usedMonthly + callMinutes > monthlyLimit) {
      return res.status(403).json({
        error: 'limit_reached',
        usage: { dailyUsed: usedDaily, monthlyUsed: usedMonthly, dailyLimit, monthlyLimit },
      });
    }

    // OpenAI Whisper çağrısı (multipart/form-data)
    let fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') fetchFn = (await import('node-fetch')).default;
    if (typeof globalThis.FormData !== 'function' || typeof globalThis.Blob !== 'function'){
      return res.status(500).json({ error: 'server_not_configured', hint: 'Node 18+ is required for FormData/Blob' });
    }
    const form = new FormData();
    const bin = Buffer.from(b64, 'base64');
    const blob = new Blob([bin], { type: mime });
    form.append('model', 'whisper-1');
    if (language) form.append('language', String(language));
    form.append('file', blob, 'audio.webm');

    const r = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      return res.status(502).json({ error: 'openai_error', status: r.status, detail: txt });
    }
    const j = await r.json();
    const text = typeof j?.text === 'string' ? j.text : '';

    // Kullanımı dakika bazlı artır
    try {
      userDoc.usage.dailyUsed = (Number(userDoc.usage.dailyUsed || 0) + callMinutes);
      userDoc.usage.monthlyUsed = (Number(userDoc.usage.monthlyUsed || 0) + callMinutes);
      // Persist aggregate Usage koleksiyonuna da yaz (best-effort)
      try {
        const y = now.getFullYear();
        const mth = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const dateBucket = `${y}-${mth}-${d}`;
        const monthBucket = `${y}-${mth}`;
        await Usage.updateOne(
          { userId: new mongoose.Types.ObjectId(uid), dateBucket, monthBucket },
          { $inc: { minutes: callMinutes } },
          { upsert: true }
        );
      } catch (aggErr) {
        console.warn('[stt] usage aggregate update failed:', aggErr?.message || aggErr);
      }
      await userDoc.save();
    } catch(e) { console.warn('[stt] minute quota increment failed:', e?.message || e); }

    return res.json({ text, quota: { dailyUsed: userDoc.usage.dailyUsed, dailyLimit, monthlyUsed: userDoc.usage.monthlyUsed, monthlyLimit, added: callMinutes } });
  } catch (e) {
    console.error('[stt] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// MongoDB'ye bağlan
mongoose.connect(MONGODB_URI, mongooseOptions).then(() => {
  console.log('MongoDB bağlantısı başarılı');
}).catch(err => {
  console.error('MongoDB bağlantı hatası:', err);
  process.exit(1);
});

const IYZICO_API_KEY = process.env.IYZICO_API_KEY || '';
const IYZICO_SECRET_KEY = process.env.IYZICO_SECRET_KEY || '';
const IYZICO_BASE_URL = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';
const PAYTR_MERCHANT_ID = process.env.PAYTR_MERCHANT_ID || '';
const PAYTR_MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY || '';
const PAYTR_MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@konuskonusabilirsen.com';

// Resend client'ı oluştur
let resend = null;
if (RESEND_API_KEY) {
  const { Resend } = await import('resend');
  resend = new Resend(RESEND_API_KEY);
}

// E-posta göndericisini oluştur (Cloudflare Email Routing için)
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net', // veya kendi SMTP sunucunuz
  port: 587,
  secure: false,
  auth: {
    user: 'apikey', // Genellikle 'apikey' kullanılır
    pass: process.env.SENDGRID_API_KEY // veya SMTP şifreniz
  }
});

// E-posta gönderme fonksiyonu
const sendEmail = async (mailOptions) => {
  try {
    const info = await transporter.sendMail(mailOptions);
    return { messageId: info.messageId };
  } catch (error) {
    console.error('E-posta gönderme hatası:', error);
    throw error;
  }
};

// Admins (comma-separated emails)
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

// Persona builder for brand-specific language coach behavior
function buildPersonaInstruction(learnLang = 'tr', nativeLang = 'tr', correction = 'gentle', scenarioText = '', userLevel = null){
  const l = String(learnLang || 'tr').toLowerCase();
  const n = String(nativeLang || 'tr').toLowerCase();
  const c = String(correction || 'gentle').toLowerCase();
  const learnName = l === 'tr' ? 'Türkçe' : (l === 'en' ? 'İngilizce' : l);
  const nativeName = n === 'tr' ? 'Türkçe' : (n === 'en' ? 'İngilizce' : n);
  const fixStyle = (
    c === 'off' ? 'Düzeltme yapma; sadece anlayıp doğal ve kısa yanıt ver.' :
    c === 'strict' ? 'Dil hatalarını tespit et ve nazik ama net şekilde düzelt. Önce kısa yanıt ver, ardından bir cümle içinde düzeltmeyi açıkla ve bir örnek ver. Örnek formatı: "Şöyle de diyebilirsin: …".' :
    'Gerekirse hataları nazikçe düzelt. Kısa yanıt ver; en fazla bir cümlelik açıklama ve küçük bir örnek ekle. Örnek formatı: "Şöyle de diyebilirsin: …".'
  );
  const safety = 'Konudan sapma; sadece kullanıcının söylediğine yanıt ver. Anlamazsan kibarca tekrar iste.';
  const tone = 'Sıcak, motive edici ve saygılı bir dil koçu gibi konuş.';
  const convo = 'Her turda: 1 kısa doğal yanıt + kullanıcıyı konuşturan tek bir kısa soru.';
  // Dil politikası: daima hedef dilde; ana dil sadece gerekirse 1 çok kısa ipucu için
  const langPolicy = `YANIT DİLİ: ${learnName} ve ${nativeName} birlikte kullan (yaklaşık %50/%50). Önce ${learnName} dilinde 1-2 doğal cümle; ardından ${nativeName} dilinde 1-2 kısa açıklama/özet ver.`;
  const mixing = `DİL GEÇİŞİ: Her cümleyi tek dilde tamamla. Cümle ortasında dil değiştirme; dil geçişini cümle sonlarında yap.`;
  // Sesli çıktı için sade biçim
  const format = `BİÇİM: (1) ${learnName} dilinde 1-2 cümle doğal yanıt. (2) ${nativeName} dilinde 1-2 cümle kısa açıklama / ipucu. (3) Örnek VERİRKEN tek kalıp kullan: Şöyle de diyebilirsin: "…". Bu kalıptan sapma; 'Şöyle bir cümle…' gibi varyasyonlar VEYA iki nokta üst üste ile bitirme.`;
  const lengthPolicy = 'UZUNLUK: Varsayılan 1-3 kısa cümle. Gerekçe varsa 4-5 cümleye çıkabilirsin ama çoğu turda 1-3 cümlede kal.';
  const closingRules = 'SONLANDIRMA: Başladığın cümleyi daima nokta ile tamamla. Asla iki nokta üst üste (:) ile bitirme. Tırnak içinde örnek başlattıysan mutlaka tırnağı kapat ve en az 4-5 kelimelik tam bir örnek ver.';
  const gentleLimits = 'Gentle modda: Anlam bozulmuyorsa düzeltme yapma. Düzeltirsen: hatayı çok kısa belirt + ana dilde 1 cümlelik ipucu + hedef dilde tek örnek.';
  const scenarioPart = scenarioText ? ` Senaryo bağlamı: ${scenarioText}` : '';
  const pacing = 'Konuşma hızını biraz yavaş tut. 1-2 kısa cümleyle konuş. Kullanıcıyı konuşturan kısa sorular sor.';
  const levelInstruction = userLevel ? ` Kullanıcının dil seviyesi: ${userLevel}. Bu seviyeye uygun kelimeler, dilbilgisi yapıları ve konuşma hızı kullan.` : '';
  return `Markaya özel dil koçu asistan ("konuskonusabilirsen"). Kullanıcının ana dili: ${nativeName}. Öğrenilen dil: ${learnName}. ${tone} ${convo} ${langPolicy} ${mixing} ${lengthPolicy} ${closingRules} ${format} ${fixStyle} ${gentleLimits} ${safety} ${pacing}${scenarioPart}${levelInstruction}`;
}

// OpenAI (public) envs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2025-08-28';
const RESPONSE_TEXT_ENABLED = (process.env.RESPONSE_TEXT_ENABLED ?? 'true').toLowerCase() !== 'false';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '';

// Azure OpenAI envs
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-01-preview';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-realtime';
// Force OpenAI-only as requested
const USE_AZURE = false;

// Basic validations
if (!USE_AZURE && !OPENAI_API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY is not set. Realtime features (OpenAI) will not work until you configure it in .env');
}
if (USE_AZURE) {
  console.log('[config] Using Azure OpenAI Realtime endpoint');
}
if (!RESEND_API_KEY) {
  console.warn('[WARN] RESEND_API_KEY not set. Emails will NOT be sent, links will be printed to console instead.');
}
if (RESEND_API_KEY && !MAIL_FROM) {
  console.warn('[WARN] MAIL_FROM is empty; set MAIL_FROM to a verified sender (e.g., no-reply@yourdomain.com).');
}

// Middleware
app.use(express.json({ limit: '10mb' }));

// Tüm API istekleri için genel zaman aşımı (30 saniye)
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'İstek zaman aşımına uğradı' });
    }
  });
  next();
});

// İstek sürelerini ölçmek için middleware
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} başladı`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} [${duration}ms]`);
  });
  
  next();
});

app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
// HTTP compression for text-based responses (tune level for balance)
app.use(compression({
  level: 6,
  threshold: '1kb'
}));

// Security headers (CSP tuned for this app)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://api.konuskonusabilirsen.com", "https://api.openai.com", "wss:", "ws:"],
      "worker-src": ["'self'", "blob:", "https://cdn.jsdelivr.net"],
      "child-src": ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS middleware yukarıda uygulanıyor

// Rate limit
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
});

// Route-bazlı ek limitler
const strictLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, trustProxy: true });
const mediumLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, trustProxy: true });

// --- Admin: recent analytics records ---
app.get('/admin/analytics/recent', authRequired, async (req, res) => {
  try {
    const caller = String(req.auth?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(caller)){
      return res.status(403).json({ error: 'forbidden' });
    }
    const { limit = 50, excludeIp = '', onlyNonTR, country } = req.query || {};
    const lmt = Math.max(1, Math.min(500, Number(limit) || 50));
    const match = {};
    const excluded = String(excludeIp || '')
      .split(',')
      .map(s => String(s).trim())
      .filter(Boolean);
    const excludedSet = new Set(excluded);
    excluded.forEach(ip => { if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) excludedSet.add(`::ffff:${ip}`); });
    const exList = Array.from(excludedSet);
    if (exList.length) match.ipRaw = { $nin: exList };
    const nonTR = String(onlyNonTR || '').toLowerCase();
    if (nonTR === '1' || nonTR === 'true') match.country = { $ne: 'TR' };
    if (country) match.country = String(country);
    let docs = await Analytics.find(match).sort({ ts: -1 }).limit(lmt).lean();
    // Extra safety: post-filter excluded IPs
    if (exList.length) docs = docs.filter(d => !exList.includes(String(d.ipRaw || '')));
    // Return selected fields only
    const items = docs.map(d => ({
      ts: d.ts,
      path: d.path,
      referrer: d.referrer || '-',
      userAgent: d.userAgent || '-',
      ip: d.ipRaw || null,
      country: d.country || null,
      city: d.city || null,
      region: d.region || null,
      countrySource: d.countrySource || null,
    }));
    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- Protected: Placement test result ----
app.patch('/me/placement', authRequired, async (req, res) => {
  try {
    const { level } = req.body || {};
    const allowed = new Set(['A1','A2','B1','B2','C1','C2']);
    if (typeof level !== 'string' || !allowed.has(level)) {
      return res.status(400).json({ error: 'invalid_level' });
    }
    const placementCompletedAt = new Date();
    const userDoc = await User.findByIdAndUpdate(
      req.auth.uid,
      { $set: { placementLevel: level, placementCompletedAt } },
      { new: true }
    );
    if (!userDoc) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, placementLevel: userDoc.placementLevel, placementCompletedAt: userDoc.placementCompletedAt });
  } catch (e){
    return res.status(500).json({ error: 'server_error' });
  }
});

// --- Admin: Analytics summary ---
app.get('/admin/analytics/summary', authRequired, async (req, res) => {
  try {
    const caller = String(req.auth?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(caller)){
      return res.status(403).json({ error: 'forbidden' });
    }
    const { from, to, limit = 10, excludeIp = '', onlyNonTR, country } = req.query || {};
    const lmt = Math.max(1, Math.min(100, Number(limit) || 10));
    const match = {};
    if (from || to){
      match.ts = {};
      if (from) match.ts.$gte = new Date(from + 'T00:00:00Z');
      if (to) match.ts.$lte = new Date(to + 'T23:59:59Z');
    }
    const excluded = String(excludeIp || '')
      .split(',')
      .map(s => String(s).trim())
      .filter(Boolean);
    const excludedSet = new Set(excluded);
    excluded.forEach(ip => { if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) excludedSet.add(`::ffff:${ip}`); });
    const exList = Array.from(excludedSet);
    if (exList.length) match.ipRaw = { $nin: exList };
    const nonTR = String(onlyNonTR || '').toLowerCase();
    if (nonTR === '1' || nonTR === 'true') match.country = { $ne: 'TR' };
    if (country) match.country = String(country);
    // Totals
    const total = await Analytics.countDocuments(match);
    // By day
    const byDay = await Analytics.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    // Top countries
    const countries = await Analytics.aggregate([
      { $match: match },
      { $group: { _id: '$country', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: lmt }
    ]);
    // Top paths
    const paths = await Analytics.aggregate([
      { $match: match },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: lmt }
    ]);
    // Top referrers
    const referrers = await Analytics.aggregate([
      { $match: match },
      { $group: { _id: '$referrer', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: lmt }
    ]);
    // IP counts with unique user estimation (uid+anonId) + country (most recent per IP)
    const ipCounts = await Analytics.aggregate([
      { $match: match },
      { $sort: { ts: -1 } },
      { $group: { _id: '$ipRaw', count: { $sum: 1 }, country: { $first: '$country' }, users: { $addToSet: '$uid' }, anon: { $addToSet: '$anonId' } } },
      { $project: { _id: 0, ip: '$_id', country: 1, count: 1, uniqueUsers: { $size: { $setDifference: [ { $setUnion: ['$users', '$anon'] }, [null] ] } } } },
      { $sort: { count: -1 } },
      { $limit: lmt }
    ]);
    return res.json({ total, byDay, countries, paths, referrers, ipCounts });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// --- Admin: IP counts endpoint (same filters as summary) ---
app.get('/admin/analytics/ip-counts', authRequired, async (req, res) => {
  try {
    const caller = String(req.auth?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(caller)){
      return res.status(403).json({ error: 'forbidden' });
    }
    const { from, to, limit = 50, excludeIp = '', onlyNonTR, country } = req.query || {};
    const lmt = Math.max(1, Math.min(500, Number(limit) || 50));
    const match = {};
    if (from || to){
      match.ts = {};
      if (from) match.ts.$gte = new Date(from + 'T00:00:00Z');
      if (to) match.ts.$lte = new Date(to + 'T23:59:59Z');
    }
    const excluded = String(excludeIp || '')
      .split(',')
      .map(s => String(s).trim())
      .filter(Boolean);
    const excludedSet = new Set(excluded);
    excluded.forEach(ip => { if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) excludedSet.add(`::ffff:${ip}`); });
    const exList = Array.from(excludedSet);
    if (exList.length) match.ipRaw = { $nin: exList };
    const nonTR = String(onlyNonTR || '').toLowerCase();
    if (nonTR === '1' || nonTR === 'true') match.country = { $ne: 'TR' };
    if (country) match.country = String(country);
    const rows = await Analytics.aggregate([
      { $match: match },
      { $sort: { ts: -1 } },
      { $group: { _id: '$ipRaw', count: { $sum: 1 }, country: { $first: '$country' }, users: { $addToSet: '$uid' }, anon: { $addToSet: '$anonId' } } },
      { $project: { _id: 0, ip: '$_id', country: 1, count: 1, uniqueUsers: { $size: { $setDifference: [ { $setUnion: ['$users', '$anon'] }, [null] ] } } } },
      { $sort: { count: -1 } },
      { $limit: lmt }
    ]);
    return res.json({ items: rows });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// --- Admin: whoami helper (detect requester IP) ---
app.get('/admin/whoami', authRequired, async (req, res) => {
  try{
    const caller = String(req.auth?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(caller)){
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.json({ ip: req.ip, ips: req.ips || [], xff: req.headers['x-forwarded-for'] || null, ua: req.headers['user-agent'] || null });
  }catch(e){ return res.status(500).json({ error: 'server_error' }); }
});

// Pretty URL for realtime (hide .html in address bar)
app.get(['/realtime', '/realtime/'], (_req, res) => {
  try {
    return res.sendFile(path.join(publicDir, 'realtime.html'));
  } catch {
    return res.status(404).end();
  }
});
// Redirect legacy .html path to pretty URL
app.get('/realtime.html', (_req, res) => res.redirect(301, '/realtime'));

// Pretty URL for OCR page (now at /ceviri)
app.get(['/ceviri', '/ceviri/'], (_req, res) => {
  try {
    return res.sendFile(path.join(publicDir, 'ocr.html'));
  } catch {
    return res.status(404).end();
  }
});

// Redirect legacy /ocr to /ceviri
app.get(['/ocr', '/ocr/'], (_req, res) => res.redirect(301, '/ceviri'));
// Route-bazlı ek limitler
// (tanımlar yukarıda yapıldı)

// Kritik uçlara uygulama (rotalardan ÖNCE)
app.use('/auth', strictLimiter);       // login/register/verify/forgot vb.
app.use('/api/paytr', strictLimiter);  // ödeme başlangıç uçları
app.use('/usage', mediumLimiter);      // kullanım özeti

// Resend verification by email (no auth) — safe: only for existing, unverified users
app.post('/auth/verify/request-by-email', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'invalid_input' });
    const lower = String(email).toLowerCase();
    const user = await User.findOne({ email: lower });
    if (!user) return res.json({ ok: true }); // do not leak existence
    if (user.emailVerified) return res.json({ ok: true });
    const token = randToken(16);
    const expires = new Date(Date.now() + 24*60*60*1000);
    user.verifyToken = token; user.verifyExpires = expires;
    await user.save();
    const url = `${req.protocol}://${req.get('host')}/verify.html?token=${token}`;
    if (resend) {
      console.log(`[resend] sending verify email to ${lower} (request-by-email)`);
      const { data, error } = await resend.emails.send({ from: MAIL_FROM, to: lower, subject: 'E-posta Doğrulama - KonusKonusabilirsen', html: `<p>E-posta adresinizi doğrulamak için bağlantıya tıklayın:</p><p><a href="${url}">${url}</a></p>` });
      if (error) { console.error('[resend] verify-by-email error:', error); }
      else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
    } else {
      console.log(`[mail] E-posta doğrulama (${lower}): ${url}`);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- DEV FALLBACK (no payment provider configured) ----
app.post('/api/dev/activate-plan', authRequired, async (req, res) => {
  try {
    const isProd = NODE_ENV === 'production';
    const hasPaytr = !!(PAYTR_MERCHANT_ID && PAYTR_MERCHANT_KEY && PAYTR_MERCHANT_SALT);
    if (isProd || hasPaytr) {
      return res.status(403).json({ error: 'disabled', hint: 'Bu uç sadece geliştirme ortamında ve ödeme sağlayıcısı yokken aktif.' });
    }
    const { plan = 'starter' } = req.body || {};
    await Subscription.findOneAndUpdate(
      { userId: req.auth.uid, plan },
      { $set: { status: 'active', currentPeriodEnd: null } },
      { upsert: true }
    );
    return res.json({ ok: true, plan });
  } catch (e) {
    console.error('[dev] activate-plan error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- JWT Auth Middleware ----
function authRequired(req, res, next){
  try {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)/i.exec(h);
    if (!m) return res.status(401).json({ error: 'missing_token' });
    const token = m[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = { uid: payload.uid, email: payload.email };
    next();
  } catch (e){
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Plan limitlerini döndüren yardımcı fonksiyon
function getPlanLimit(plan, type) {
  const limits = {
    free: { daily: 3, monthly: 10 },
    economy: { daily: 10, monthly: 300 },
    starter: { daily: 15, monthly: 450 },
    pro: { daily: 60, monthly: 1800 }
  };
  return (limits[plan] && limits[plan][type]) || limits.free[type];
}

// Kullanıcı planını güncelleme endpoint'i
app.post('/api/update-plan', authRequired, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { plan } = req.body || {};
    
    if (!['free', 'economy', 'starter', 'pro'].includes(plan)) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Geçersiz plan seçimi' });
    }

    const user = await User.findById(req.auth.uid).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    // Eski planı kaydet
    const oldPlan = user.plan;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Kullanıcı bilgilerini güncelle
    user.plan = plan;
    user.planUpdatedAt = now;
    
    // Kullanım sınırlarını güncelle
    user.usage = user.usage || {};
    user.usage.dailyLimit = getPlanLimit(plan, 'daily');
    user.usage.monthlyLimit = getPlanLimit(plan, 'monthly');
    user.usage.dailyUsed = 0;
    user.usage.monthlyUsed = 0;
    user.usage.lastReset = now;
    user.usage.monthlyResetAt = startOfMonth;
    user.updatedAt = now;
    
    // Kullanıcıyı kaydet ve değişiklikleri onayla
    await user.save({ session });
    
    // Transaction'ı tamamla
    await session.commitTransaction();
    
    // Kullanıcı bilgilerini logla
    console.log(`[${new Date().toISOString()}] Kullanıcı planı güncellendi:`, {
      userId: req.auth.uid,
      email: user.email,
      oldPlan,
      newPlan: plan
    });
    
    return res.json({ 
      success: true, 
      message: 'Plan başarıyla güncellendi',
      plan: {
        current: plan,
        previous: oldPlan,
        updatedAt: user.planUpdatedAt,
        limits: {
          daily: user.usage.dailyLimit,
          monthly: user.usage.monthlyLimit
        }
      }
    });
    
  } catch (error) {
    // Hata durumunda transaction'ı geri al
    await session.abortTransaction();
    console.error('Plan güncelleme hatası:', error);
    return res.status(500).json({ 
      error: 'Plan güncellenirken bir hata oluştu',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Session'ı kapat
    await session.endSession();
  }
});

// Kullanıcı planını manuel olarak güncellemek için admin endpoint'i
app.post('/api/admin/update-user-plan', authRequired, async (req, res) => {
  try {
    const { userId, newPlan } = req.body || {};
    
    // Basit güvenlik kontrolü (sadece admin kullanıcılar için)
    const adminUser = await User.findById(req.auth.uid);
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok' });
    }
    
    if (!userId || !['free', 'economy', 'starter', 'pro'].includes(newPlan)) {
      return res.status(400).json({ error: 'Geçersiz istek' });
    }
    
    // Kullanıcıyı bul
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    // Eski planı kaydet
    const oldPlan = user.plan;
    
    // Kullanıcının planını güncelle
    user.plan = newPlan;
    user.planUpdatedAt = new Date();
    
    // Kullanım sınırlarını güncelle
    user.usage = user.usage || {};
    user.usage.dailyLimit = getPlanLimit(newPlan, 'daily');
    user.usage.monthlyLimit = getPlanLimit(newPlan, 'monthly');
    user.usage.dailyUsed = 0;
    user.usage.monthlyUsed = 0;
    user.usage.lastReset = new Date();
    user.usage.monthlyResetAt = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    
    // Değişiklikleri kaydet
    await user.save();
    
    console.log(`[${new Date().toISOString()}] ADMIN: Kullanıcı planı manuel olarak güncellendi`, {
      admin: adminUser.email,
      userId: user._id,
      userEmail: user.email,
      oldPlan,
      newPlan,
      ip: req.ip
    });
    
    return res.json({ 
      success: true, 
      message: 'Kullanıcı planı başarıyla güncellendi',
      userId: user._id,
      email: user.email,
      oldPlan,
      newPlan
    });
    
  } catch (error) {
    console.error('Admin plan güncelleme hatası:', error);
    return res.status(500).json({ error: 'Sunucu hatası', details: error.message });
  }
});

// ---- Protected: Update user plan and reset usage ----

// ---- Protected:// Kullanıcı bilgilerini debug etmek için endpoint
app.get('/api/debug/user', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.auth.uid).lean();
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    // Hassas bilgileri temizle
    const { passwordHash, verifyToken, resetToken, ...safeUser } = user;
    
    return res.json({
      ...safeUser,
      _id: safeUser._id.toString(),
      createdAt: safeUser.createdAt?.toISOString(),
      updatedAt: safeUser.updatedAt?.toISOString(),
      planUpdatedAt: safeUser.planUpdatedAt?.toISOString(),
      'usage.lastReset': safeUser.usage?.lastReset?.toISOString(),
      'usage.monthlyResetAt': safeUser.usage?.monthlyResetAt?.toISOString()
    });
  } catch (error) {
    console.error('Debug user error:', error);
    return res.status(500).json({ 
      error: 'Bir hata oluştu',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Kullanıcı bilgilerini getir
app.get('/me', authRequired, async (req, res) => {
  try {
    console.log(`[DEBUG] /me çağrısı - userId: ${req.auth.uid}`);
    // Kullanıcı bilgilerini al
    const user = await User.findById(req.auth.uid);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    console.log(`[DEBUG] /me - user.usage mevcut değerler:`, JSON.stringify(user.usage, null, 2));

    // Kullanım objesini garanti et ve eksik alanları set et
    user.usage = user.usage || {};
    const now = new Date();

    // Eksik alanları set et
    if (!user.usage.dailyLimit) {
      user.usage.dailyLimit = getPlanLimit(user.plan || 'free', 'daily');
    }
    if (!user.usage.monthlyLimit) {
      user.usage.monthlyLimit = getPlanLimit(user.plan || 'free', 'monthly');
    }
    if (!user.usage.lastReset) {
      user.usage.lastReset = now;
    }
    if (!user.usage.monthlyResetAt) {
      user.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const lastReset = new Date(user.usage.lastReset);
    const monthlyReset = new Date(user.usage.monthlyResetAt);

    console.log(`[DEBUG] /me - zaman karşılaştırması: now=${now}, lastReset=${lastReset}, monthlyReset=${monthlyReset}`);

    // Günlük kullanımı sıfırla (eğer yeni bir gün başladıysa)
    if (now.toDateString() !== lastReset.toDateString()) {
      user.usage.dailyUsed = 0;
      user.usage.lastReset = now;
      console.log(`[DEBUG] /me - günlük kullanım sıfırlandı`);
    }

    // Aylık kullanımı sıfırla (eğer yeni bir ay başladıysa)
    if (now > monthlyReset) {
      user.usage.monthlyUsed = 0;
      user.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      console.log(`[DEBUG] /me - aylık kullanım sıfırlandı`);
    }

    // Plan değişikliği sonrası kullanımları sıfırla
    const planUpdatedAt = new Date(user.planUpdatedAt || 0);
    if (planUpdatedAt > lastReset) {
      console.log(`[DEBUG] /me - plan değişikliği tespit edildi (${user.plan}), kullanımlar sıfırlanıyor`);
      user.usage.dailyUsed = 0;
      user.usage.monthlyUsed = 0;
      user.usage.lastReset = now;
      user.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }

    // Değişiklikleri kaydet
    await user.save();

    // Kullanıcı bilgilerini döndür
    const response = {
      user: {
        id: user._id,
        email: user.email,
        emailVerified: user.emailVerified,
        plan: user.plan || 'free',
        planUpdatedAt: user.planUpdatedAt,
        usage: {
          dailyUsed: user.usage?.dailyUsed || 0,
          dailyLimit: user.usage?.dailyLimit || getPlanLimit(user.plan || 'free', 'daily'),
          monthlyUsed: user.usage?.monthlyUsed || 0,
          monthlyLimit: user.usage?.monthlyLimit || getPlanLimit(user.plan || 'free', 'monthly'),
          lastReset: user.usage?.lastReset,
          monthlyResetAt: user.usage?.monthlyResetAt
        },
        preferredVoice: user.preferredVoice,
        preferredCorrectionMode: user.preferredCorrectionMode || 'gentle',
        preferredLearningLanguage: user.preferredLearningLanguage || 'en',
        preferredNativeLanguage: user.preferredNativeLanguage || 'tr',
        placementLevel: user.placementLevel,
        placementCompletedAt: user.placementCompletedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    };

    console.log(`[DEBUG] /me - döndürülen usage değerleri:`, JSON.stringify(response.user.usage, null, 2));
    return res.json(response);
  } catch (error) {
    console.error('Kullanıcı bilgileri alınırken hata:', error);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kullanıcı bilgilerini güncelle (PATCH /me)
app.patch('/me', authRequired, async (req, res) => {
  try {
    const allowedFields = ['preferredVoice', 'preferredCorrectionMode', 'preferredLearningLanguage', 'preferredNativeLanguage', 'placementLevel'];
    const updates = {};

    // Sadece izin verilen alanları güncelle
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (typeof req.body[field] === 'string') {
          updates[field] = req.body[field];
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_updates' });
    }

    const userDoc = await User.findByIdAndUpdate(req.auth.uid, updates, { new: true });
    if (!userDoc) return res.status(404).json({ error: 'not_found' });

    return res.json({
      ok: true,
      user: {
        id: userDoc._id,
        email: userDoc.email,
        emailVerified: userDoc.emailVerified,
        plan: userDoc.plan || 'free',
        planUpdatedAt: userDoc.planUpdatedAt,
        usage: {
          dailyUsed: userDoc.usage?.dailyUsed || 0,
          dailyLimit: userDoc.usage?.dailyLimit || getPlanLimit(userDoc.plan || 'free', 'daily'),
          monthlyUsed: userDoc.usage?.monthlyUsed || 0,
          monthlyLimit: userDoc.usage?.monthlyLimit || getPlanLimit(userDoc.plan || 'free', 'monthly'),
          lastReset: userDoc.usage?.lastReset,
          monthlyResetAt: userDoc.usage?.monthlyResetAt
        },
        preferredVoice: userDoc.preferredVoice,
        preferredCorrectionMode: userDoc.preferredCorrectionMode || 'gentle',
        preferredLearningLanguage: userDoc.preferredLearningLanguage || 'en',
        preferredNativeLanguage: userDoc.preferredNativeLanguage || 'tr',
        placementLevel: userDoc.placementLevel,
        placementCompletedAt: userDoc.placementCompletedAt,
        createdAt: userDoc.createdAt,
        updatedAt: userDoc.updatedAt
      }
    });
  } catch (error) {
    console.error('Kullanıcı güncelleme hatası:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Kullanım takibi için endpoint
app.post('/api/track-usage', authRequired, async (req, res) => {
  try {
    const { minutes } = req.body;
    
    if (typeof minutes !== 'number' || minutes <= 0) {
      return res.status(400).json({ error: 'Geçersiz süre değeri' });
    }
    
    const user = await User.findById(req.auth.uid);
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    // Kullanım sıfırlama kontrolleri
    const now = new Date();
    const lastReset = new Date(user.usage.lastReset);
    const monthlyReset = new Date(user.usage.monthlyResetAt);
    
    // Günlük kullanımı sıfırla (eğer yeni bir gün başladıysa)
    if (now.toDateString() !== lastReset.toDateString()) {
      user.usage.dailyUsed = 0;
      user.usage.lastReset = now;
    }
    
    // Aylık kullanımı sıfırla (eğer yeni bir ay başladıysa)
    if (now > monthlyReset) {
      user.usage.monthlyUsed = 0;
      user.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }
    
    // Kullanımı güncelle
    user.usage.dailyUsed += minutes;
    user.usage.monthlyUsed += minutes;
    
    // Kullanım limitlerini aşıp aşmadığını kontrol et
    const isDailyLimitExceeded = user.usage.dailyUsed > getPlanLimit(user.plan || 'free', 'daily');
    const isMonthlyLimitExceeded = user.usage.monthlyUsed > getPlanLimit(user.plan || 'free', 'monthly');
    
    // Değişiklikleri kaydet
    await user.save();
    
    return res.json({
      success: true,
      usage: {
        dailyUsed: user.usage.dailyUsed,
        dailyLimit: getPlanLimit(user.plan || 'free', 'daily'),
        monthlyUsed: user.usage.monthlyUsed,
        monthlyLimit: getPlanLimit(user.plan || 'free', 'monthly'),
        lastReset: user.usage.lastReset,
        monthlyResetAt: user.usage.monthlyResetAt,
        isDailyLimitExceeded,
        isMonthlyLimitExceeded
      }
    });
    
  } catch (error) {
    console.error('Kullanım takip hatası:', error);
    return res.status(500).json({ error: 'Kullanım takip edilirken bir hata oluştu' });
  }
});
app.patch('/me/preferences', authRequired, async (req, res) => {
  try {
    const { preferredVoice, preferredCorrectionMode, preferredLearningLanguage, preferredNativeLanguage } = req.body || {};
    const updates = {};
    if (typeof preferredVoice === 'string') updates.preferredVoice = preferredVoice;
    if (typeof preferredCorrectionMode === 'string') updates.preferredCorrectionMode = preferredCorrectionMode;
    if (typeof preferredLearningLanguage === 'string') updates.preferredLearningLanguage = preferredLearningLanguage;
    if (typeof preferredNativeLanguage === 'string') updates.preferredNativeLanguage = preferredNativeLanguage;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_updates' });
    }

    const userDoc = await User.findByIdAndUpdate(req.auth.uid, updates, { new: true });
    if (!userDoc) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true,
      preferredVoice: userDoc.preferredVoice || null,
      preferredCorrectionMode: userDoc.preferredCorrectionMode || 'gentle',
      preferredLearningLanguage: userDoc.preferredLearningLanguage || 'en',
      preferredNativeLanguage: userDoc.preferredNativeLanguage || 'tr'
    });
  } catch (e){
    return res.status(500).json({ error: 'server_error' });
  }
});
app.use(limiter);

// Static web client
import path from 'path';
import { fileURLToPath } from 'url';
import { Analytics } from './models.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
// Load scenarios from filesystem (src/scenarios/*.json)
const scenarios = new Map();
function loadScenarios(){
  try {
    const scenariosDir = path.join(__dirname, 'scenarios');
    if (!fs.existsSync(scenariosDir)) return;
    const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(scenariosDir, f), 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.id) scenarios.set(String(obj.id), obj);
      } catch (e) {
        console.warn('[scenarios] parse error for', f, e?.message || e);
      }
    }
    console.log(`[scenarios] loaded ${scenarios.size} scenario(s)`);
  } catch (e) {
    console.warn('[scenarios] load error:', e?.message || e);
  }
}
loadScenarios();
// Enable trust proxy for correct req.ip behind proxies (set explicit hop count instead of boolean true)
try { app.set('trust proxy', true); } catch {}

// --- In-house analytics middleware (non-blocking) ---
function hashIp(ip){
  try { return crypto.createHash('sha256').update(String(ip||'')).digest('hex').slice(0,32); } catch { return null; }
}
function isPrivateIp(ip){
  try{
    if (!ip) return true;
    // remove IPv6 localhost/zone
    const x = ip.replace('::ffff:','');
    return (
      x.startsWith('10.') ||
      x.startsWith('192.168.') ||
      x.startsWith('172.16.') || x.startsWith('172.17.') || x.startsWith('172.18.') || x.startsWith('172.19.') ||
      x.startsWith('172.20.') || x.startsWith('172.21.') || x.startsWith('172.22.') || x.startsWith('172.23.') ||
      x.startsWith('172.24.') || x.startsWith('172.25.') || x.startsWith('172.26.') || x.startsWith('172.27.') ||
      x.startsWith('172.28.') || x.startsWith('172.29.') || x.startsWith('172.30.') || x.startsWith('172.31.') ||
      x === '127.0.0.1' || x === '::1'
    );
  } catch { return true; }
}

// Simple in-memory IP -> country cache (TTL 6h)
const ipCountryCache = new Map();
function cacheSet(ip, country){ ipCountryCache.set(ip, { country, ts: Date.now() }); }
function cacheGet(ip){
  const v = ipCountryCache.get(ip);
  if (!v) return null;
  if (Date.now() - v.ts > 6*60*60*1000){ ipCountryCache.delete(ip); return null; }
  return v.country || null;
}

// Minimal cookie parser and anon ID assignment (no external deps)
function parseCookies(req){
  try{
    const h = req.headers['cookie'];
    if (!h) return {};
    return h.split(';').map(s=>s.trim()).filter(Boolean).reduce((acc, kv)=>{
      const i = kv.indexOf('=');
      if (i>0){ acc[decodeURIComponent(kv.slice(0,i))] = decodeURIComponent(kv.slice(i+1)); }
      return acc;
    }, {});
  } catch { return {}; }
}
function getOrSetAnonId(req, res){
  try{
    const cookies = parseCookies(req);
    let id = cookies['hk_anon'] || '';
    if (!id){
      id = uuidv4();
      const isSecure = (req.protocol === 'https') || (req.headers['x-forwarded-proto'] === 'https');
      const cookie = `hk_anon=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${isSecure?'; Secure':''}`;
      try { res.setHeader('Set-Cookie', cookie); } catch {}
    }
    return id;
  } catch { return null; }
}
app.use((req, res, next) => {
  try {
    // Log only GET page views; skip static assets by extension
    if (req.method !== 'GET') return next();
    const p = String(req.path || '/');
    if (/\.(css|js|png|jpg|jpeg|svg|ico|gif|webp|mp3|wav|ogg|woff|woff2|ttf|map)$/i.test(p)) return next();
    const ref = req.get('referer') || null;
    const ua = req.get('user-agent') || null;
    const host = req.headers['host'] || null;
    // Choose first public IP from X-Forwarded-For chain
        const priorityIp = (req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.headers['x-real-ip'] || req.headers['x-client-ip'] || '').toString().trim();
    let chosenIp = priorityIp && !isPrivateIp(priorityIp) ? priorityIp : null;
    const xff = (req.headers['x-forwarded-for'] || '').toString();
    const chain = xff.split(',').map(s => s.trim()).filter(Boolean);
    // chosenIp initialized above if present
    for (const cand of chain){ if (!isPrivateIp(cand)) { chosenIp = cand; break; } }
    if (!chosenIp) chosenIp = (req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '').toString();
    const ip = chosenIp.replace('::ffff','').replace('::ffff:','');
    const ipHash = hashIp(ip);
    let country = (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country'] || null) || null;
    let countrySource = country ? 'header' : null;
    const uid = req.auth?.uid ? new mongoose.Types.ObjectId(req.auth.uid) : null;
    const anonId = getOrSetAnonId(req, res) || null;
    const doc = { path: p, host, referrer: ref, userAgent: ua, ipHash, ipRaw: ip, country, countrySource, anonId, uid, ts: new Date() };
    Analytics.create(doc).then(async (saved) => {
      try {
        const cached = !country ? cacheGet(ip) : null;
        if (!country && cached){
          await Analytics.updateOne({ _id: saved._id }, { $set: { country: cached, countrySource: 'cache' } });
          country = cached;
        }
        // Tokenli ipinfo öncelik; yoksa ipwho.is ücretsiz fallback (HTTPS destekli)
        if (!country && ip && !isPrivateIp(ip)){
          if (IPINFO_TOKEN){
            const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${encodeURIComponent(IPINFO_TOKEN)}`);
            if (r.ok){
              const j = await r.json();
              const cc = j && (j.country || j.country_name || null);
              const city = j && (j.city || null);
              const region = j && (j.region || j.state || null);
              if (cc){ cacheSet(ip, cc); await Analytics.updateOne({ _id: saved._id }, { $set: { country: cc, city, region, countrySource: 'ipinfo' } }); country = cc; }
            }
          }
          if (!country){
            const r2 = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
            if (r2.ok){
              const j2 = await r2.json();
              if (j2 && j2.success){
                const cc2 = j2.country_code || null;
                const city2 = j2.city || null;
                const region2 = j2.region || null;
                if (cc2){ await Analytics.updateOne({ _id: saved._id }, { $set: { country: cc2, city: city2, region: region2, countrySource: 'ipwho' } }); cacheSet(ip, cc2); }
              }
            }
          }
        }
      } catch {}
    }).catch(()=>{});
  } catch {}
  next();
});

// Pretty URL for realtime (hide .html in address bar) — must be BEFORE static middleware
try {
  app.get(['/realtime', '/realtime/'], (_req, res) => {
    return res.sendFile(path.join(publicDir, 'realtime.html'));
  });
  // Redirect legacy .html path to pretty URL
  app.get('/realtime.html', (_req, res) => res.redirect(301, '/realtime'));
  // Pretty URL for economy page
  app.get(['/ekonomi', '/ekonomi/'], (_req, res) => {
    return res.sendFile(path.join(publicDir, 'economy.html'));
  });
  app.get('/economy.html', (_req, res) => res.redirect(301, '/ekonomi'));
} catch {}
// Static with Cache-Control
app.use(express.static(publicDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const p = filePath.toLowerCase();
    if (p.endsWith('.html')) {
      // HTML should not be cached aggressively
      res.setHeader('Cache-Control', 'no-cache');
    } else if (p.endsWith('.json')) {
      res.setHeader('Cache-Control', 'public, max-age=60');
    } else if (p.endsWith('.css') || p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.svg') || p.endsWith('.webp') || p.endsWith('.ico')) {
      // Cache static assets for a week; if you add content hashes, this can be increased
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else if (p.endsWith('.js')) {
      // During development, do not aggressively cache JS to avoid stale app.js
      if (NODE_ENV === 'production') {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }
}));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(publicDir, 'contact.html')));

// Redirect success.html to main domain
app.get('/success.html', (req, res) => {
  res.redirect(301, 'https://konuskonusabilirsen.com/konus');
});

// Handle contact form submission
app.post('/api/contact', [
  body('name').trim().notEmpty().withMessage('Lütfen adınızı girin'),
  body('email').isEmail().withMessage('Lütfen geçerli bir e-posta adresi girin'),
  body('message').trim().notEmpty().withMessage('Lütfen bir mesaj yazın')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Geçersiz form verileri',
        errors: errors.array()
      });
    }

    const { name, email, message } = req.body;
    
    // Email options - send to admin
    const mailOptions = {
      from: 'noreply@konuskonusabilirsen.com', // Cloudflare'de onaylı gönderici adresi
      replyTo: email, // Kullanıcının yanıt verebilmesi için
      to: 'info@konuskonusabilirsen.com',
      subject: `Yeni İletişim Formu: ${name}`,
      text: `
        İsim: ${name}
        E-posta: ${email}
        
        Mesaj:
        ${message}
        
        Bu mesajı yanıtlamak için e-posta istemcinizde "Yanıtla" butonuna tıklayın.
      `,
      html: `
        <h2>Yeni İletişim Formu</h2>
        <p><strong>İsim:</strong> ${name}</p>
        <p><strong>E-posta:</strong> ${email}</p>
        <p><strong>Mesaj:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
        <p><em>Bu mesajı yanıtlamak için e-posta istemcinizde "Yanıtla" butonuna tıklayın.</em></p>
      `
    };

    // Send email to admin
    await transporter.sendMail(mailOptions);
    
    // Send a copy to the user from noreply address
    const userMailOptions = {
      from: `"KonusKonusabilirsen" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Mesajınız Alındı - KonusKonusabilirsen',
      text: `Merhaba ${name},

İletişim formunuzu aldık. Size en kısa sürede dönüş yapacağız.

Gönderdiğiniz mesaj:
${message}

Bu bir otomatik yanıttır. Lütfen bu e-postaya yanıt vermeyiniz.

Saygılarımızla,
KonusKonusabilirsen Ekibi`,
      html: `
        <p>Merhaba <strong>${name}</strong>,</p>
        <p>İletişim formunuzu aldık. Size en kısa sürede dönüş yapacağız.</p>
        <p><strong>Gönderdiğiniz mesaj:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
        <p><em>Bu bir otomatik yanıttır. Lütfen bu e-postaya yanıt vermeyiniz.</em></p>
        <p>Saygılarımızla,<br>KonusKonusabilirsen Ekibi</p>
      `
    };

    // Send copy to user
    await transporter.sendMail(userMailOptions);
    
    res.json({ 
      success: true, 
      message: 'Mesajınız başarıyla gönderildi. Teşekkür ederiz!' 
    });
    
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Mesaj gönderilirken bir hata oluştu. Lütfen daha sonra tekrar deneyin.' 
    });
  }
});

// Handle CORS preflight for contact form
app.options('/api/contact', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).end();
});

// Contact form submission
app.post('/api/contact', express.json(), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    console.log('Received contact form submission:', { name, email, subject, message });

    // Basic validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Lütfen tüm alanları doldurunuz.' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi giriniz.' });
    }

    // E-posta gönder
    try {
      const mailOptions = {
        from: `"${name}" <${process.env.EMAIL_USER || 'noreply@konuskonusabilirsen.com'}>`,
        to: 'info@konuskonusabilirsen.com',
        replyTo: email,
        subject: `İletişim Formu: ${subject}`,
        html: `
          <h2>Yeni İletişim Formu Gönderimi</h2>
          <p><strong>Ad Soyad:</strong> ${name}</p>
          <p><strong>E-posta:</strong> ${email}</p>
          <p><strong>Konu:</strong> ${subject}</p>
          <p><strong>Mesaj:</strong></p>
          <p>${String(message).replace(/\n/g, '<br>')}</p>
        `
      };

      console.log('E-posta gönderiliyor:', {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject
      });

      const info = await sendEmail(mailOptions);
      console.log('E-posta gönderildi:', info.messageId);
      
      // Başarılı yanıt döndür
      return res.json({ 
        success: true, 
        message: 'Mesajınız başarıyla gönderildi. En kısa sürede size dönüş yapacağız.' 
      });
      
    } catch (error) {
      console.error('E-posta gönderme hatası:', error);
      throw new Error('E-posta gönderilirken bir hata oluştu: ' + error.message);
    }
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ 
      error: error.message || 'Mesajınız gönderilirken bir hata oluştu. Lütfen daha sonra tekrar deneyin.' 
    });
  }
});
// Fallback for browsers requesting /favicon.ico
app.get('/favicon.ico', (_req, res) => {
  try {
    return res.sendFile(path.join(publicDir, 'favicon.png'));
  } catch {
    return res.status(404).end();
  }
});
// Ensure /favicon.png also works (some UAs use the PNG link directly)
app.get('/favicon.png', (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.sendFile(path.join(publicDir, 'favicon.png'));
  } catch {
    return res.status(404).end();
  }
});

// ---- Admin: set plan for a user (no payment) ----
app.post('/admin/set-plan', authRequired, async (req, res) => {
  try {
    const caller = String(req.auth?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(caller)){
      return res.status(403).json({ error: 'forbidden', message: 'Admin yetkisi gerekli' });
    }
    const { email, plan = 'starter' } = req.body || {};
    if (!email) return res.status(400).json({ error: 'invalid_input', message: 'email zorunlu' });
    const lower = String(email).toLowerCase();
    const user = await User.findOne({ email: lower }).lean();
    if (!user) return res.status(404).json({ error: 'not_found', message: 'Kullanıcı bulunamadı' });

    // Kullanıcıyı tam olarak al (sadece lean değil)
    const userDoc = await User.findOne({ email: lower });
    if (!userDoc) return res.status(404).json({ error: 'not_found', message: 'Kullanıcı bulunamadı' });

    // Plan değişikliği kontrolü - eğer plan değişiyorsa usage'ı sıfırla
    const isPlanChange = userDoc.plan !== plan;
    console.log(`[admin/set-plan] Plan değişikliği: ${userDoc.plan} -> ${plan}, isPlanChange: ${isPlanChange}`);

    // Plan limitlerini al
    const dailyLimit = getPlanLimit(plan, 'daily');
    const monthlyLimit = getPlanLimit(plan, 'monthly');
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Tüm güncellemeleri bir seferde yap
    const updateData = {
      $set: {
        plan: plan,
        planUpdatedAt: now,
        'usage.dailyLimit': dailyLimit,
        'usage.monthlyLimit': monthlyLimit,
        'usage.lastReset': now,
        'usage.monthlyResetAt': startOfMonth
      }
    };

    // Plan değişikliğinde usage'ı da sıfırla
    if (isPlanChange) {
      console.log(`[admin/set-plan] Plan değişti, usage sıfırlanıyor`);
      updateData.$set['usage.dailyUsed'] = 0;
      updateData.$set['usage.monthlyUsed'] = 0;
    }

    console.log(`[admin/set-plan] Update data:`, JSON.stringify(updateData, null, 2));

    const updatedUser = await User.findByIdAndUpdate(user._id, updateData, { new: true, runValidators: true });

    if (!updatedUser) {
      throw new Error('Kullanıcı güncellenemedi');
    }

    console.log(`[admin/set-plan] Kullanıcı güncellendi, plan: ${updatedUser.plan}, usage:`, JSON.stringify(updatedUser.usage, null, 2));

    await Subscription.findOneAndUpdate(
      { userId: user._id, plan },
      { $set: { status: 'active', currentPeriodEnd: null } },
      { upsert: true }
    );

    // Usage collection'ını da sıfırla
    if (isPlanChange) {
      await Usage.updateOne(
        { userId: user._id },
        {
          $set: {
            minutes: 0,
            updatedAt: now
          }
        },
        { upsert: true }
      );
    }

    console.log(`[admin/set-plan] Kullanıcı ${user._id} planı ${plan} olarak güncellendi, usage sıfırlandı`);
    return res.json({ ok: true, userId: String(user._id), email: lower, plan, usageReset: isPlanChange });
  } catch (e){
    console.error('[admin/set-plan] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// List scenarios (id, title, level, tags)
app.get('/scenarios', (_req, res) => {
  try {
    const list = Array.from(scenarios.values()).map(s => ({ id: s.id, title: s.title, level: s.level || null, tags: s.tags || [] }));
    res.json({ items: list });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: NODE_ENV });
});

// Dev email test endpoint
app.post('/dev/test-email', async (req, res) => {
  try {
    const { to = '', subject = 'Test Email', html = '<p>Hello from KonusKonusabilirsen</p>' } = req.body || {};
    if (!to) return res.status(400).json({ error: 'missing_to' });
    if (!resend) return res.status(500).json({ error: 'resend_not_configured' });
    const { data, error } = await resend.emails.send({ from: MAIL_FROM, to, subject, html });
    if (error) { console.error('[dev/test-email] error:', error); }
    else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
    return res.json({ ok: true, id: data?.id || null });
  } catch (e) {
    console.error('[dev/test-email] error:', e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Auth: Register (MongoDB)
app.post('/auth/register',
  [body('email').isEmail(), body('password').isString().isLength({ min: 6 })],
  async (req, res) => {
  try {
    const vr = validationResult(req);
    if (!vr.isEmpty()) return res.status(400).json({ error: 'invalid_input' });
    const { email, password } = req.body || {};
    if (!email || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'invalid_input', hint: 'email ve en az 6 karakterli password gereklidir' });
    }
    const lower = String(email).toLowerCase();
    const existing = await User.findOne({ email: lower });
    if (existing) {
      if (existing.emailVerified) return res.status(409).json({ error: 'email_in_use' });
      // Kullanıcı var ama doğrulanmamış: şifreyi güncelle; her denemede YENİ token üret (eskisini iptal et)
      existing.passwordHash = await bcrypt.hash(String(password), 10);
      existing.verifyToken = crypto.randomBytes(16).toString('hex');
      existing.verifyExpires = new Date(Date.now() + 24*60*60*1000);
      await existing.save();
      const useToken = existing.verifyToken;
      const url = `${req.protocol}://${req.get('host')}/verify.html?token=${useToken}`;
      if (resend) {
        try {
          const { data, error } = await resend.emails.send({
            from: MAIL_FROM,
            to: lower,
            subject: 'E-posta Doğrulama - KonusKonusabilirsen',
            html: `<p>Hesabınızı doğrulamak için tıklayın:</p><p><a href="${url}">${url}</a></p>`
          });
          if (error) console.error('[resend] verify email (existing) error:', error);
          else console.log(`[resend] verify email (existing) sent id=${data?.id || 'n/a'}`);
        } catch (err) {
          console.error('[resend] verify email (existing) send error:', err);
        }
      } else {
        console.log(`[mail] Doğrulama (${lower}): ${url}`);
      }
      return res.json({ ok: true, verifySent: true });
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const verifyToken = crypto.randomBytes(16).toString('hex');
    const verifyExpires = new Date(Date.now() + 24*60*60*1000);
    const userDoc = await User.create({ email: lower, passwordHash, verifyToken, verifyExpires, emailVerified: false });
    const url = `${req.protocol}://${req.get('host')}/verify.html?token=${verifyToken}`;
    console.log('[debug] Mail gönderiliyor:', { from: MAIL_FROM, to: lower, url });
    console.log('[debug] Resend API Key var mı?', RESEND_API_KEY ? 'Evet' : 'Hayır');
    console.log('[debug] Resend client başlatıldı mı?', resend ? 'Evet' : 'Hayır');
    
    try {
      if (!resend) {
        console.log('[debug] Resend client başlatılmamış, doğrulama bağlantısı konsola yazdırılıyor');
        console.log(`[mail] Doğrulama Bağlantısı (${lower}): ${url}`);
        return res.json({ ok: true, verifySent: true });
      }
      
      console.log('[debug] Resend ile e-posta gönderiliyor...');
      const { data, error } = await resend.emails.send({
        from: MAIL_FROM,
        to: lower,
        subject: 'E-posta Doğrulama - KonusKonusabilirsen',
        html: `<p>Hesabınızı doğrulamak için tıklayın:</p><p><a href="${url}">${url}</a></p>`
      });
      
      if (error) {
        console.error('[resend] E-posta gönderme hatası:', error);
        console.log('[debug] Hata detayı:', JSON.stringify(error, null, 2));
      } else {
        console.log(`[resend] E-posta gönderildi. ID: ${data?.id || 'bilinmiyor'}`);
      }
    } catch (e) {
      console.error('E-posta gönderilirken beklenmeyen hata:', e);
      console.error('Hata detayı:', e.stack || 'Stack yok');
    }
    // Kayıt olurken JWT DÖNDÜRME: doğrulama şart
    return res.json({ ok: true, verifySent: true });
  } catch (e) {
    console.error('[auth/register] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Auth: Login (MongoDB)
app.post('/auth/login',
  [body('email').isEmail(), body('password').isString().notEmpty()],
  async (req, res) => {
  try {
    const vr = validationResult(req);
    if (!vr.isEmpty()) return res.status(400).json({ error: 'invalid_input' });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'invalid_input' });
    const lower = String(email).toLowerCase();
    const userDoc = await User.findOne({ email: lower });
    if (!userDoc) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(String(password), userDoc.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    if (!userDoc.emailVerified) {
      return res.status(403).json({ error: 'email_not_verified' });
    }
    const token = jwt.sign({ uid: String(userDoc._id), email: userDoc.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: String(userDoc._id), email: userDoc.email } });
  } catch (e) {
    console.error('[auth/login] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Expose Google Client ID to frontend (not secret)
app.get('/auth/google-client-id', (req, res) => {
  try {
    return res.json({ clientId: GOOGLE_CLIENT_ID || null });
  } catch {
    return res.json({ clientId: null });
  }
});

// Auth: Google Sign-In — verify ID token and issue our JWT
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken, credential } = req.body || {};
    const token = String(idToken || credential || '').trim();
    if (!token) return res.status(400).json({ error: 'invalid_input', hint: 'idToken missing' });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'server_not_configured', hint: 'GOOGLE_CLIENT_ID missing' });

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    } catch (e) {
      return res.status(401).json({ error: 'invalid_google_token' });
    }
    const payload = ticket.getPayload() || {};
    const sub = String(payload.sub || '');
    const email = String(payload.email || '').toLowerCase();
    const emailVerified = Boolean(payload.email_verified);
    if (!sub || !email) return res.status(400).json({ error: 'invalid_google_payload' });

    let userDoc = await User.findOne({ $or: [{ googleId: sub }, { email }] });
    if (!userDoc) {
      const randomPass = crypto.randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(randomPass, 10);
      userDoc = await User.create({ email, googleId: sub, passwordHash, emailVerified: emailVerified || true });
    } else {
      const updates = {};
      if (!userDoc.googleId) updates.googleId = sub;
      if (!userDoc.emailVerified && emailVerified) updates.emailVerified = true;
      if (Object.keys(updates).length) userDoc = await User.findByIdAndUpdate(userDoc._id, { $set: updates }, { new: true });
    }

    const jwtToken = jwt.sign({ uid: String(userDoc._id), email: userDoc.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token: jwtToken, user: { id: String(userDoc._id), email: userDoc.email } });
  } catch (e) {
    console.error('[auth/google] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- Email flows (console mailer): forgot/reset & verify ----
function randToken(len = 16){
  return crypto.randomBytes(len).toString('hex');
}

// Mask sensitive tokens in logs
function maskToken(t){
  try{
    const s = String(t||'');
    if (s.length <= 8) return '****';
    return `${s.slice(0,4)}…${s.slice(-4)}`;
  } catch { return '****'; }
}

// Payment success email (Resend)
async function sendPaymentSuccessEmail(to, { plan, amountTl, oid }){
  try{
    if (!resend || !MAIL_FROM) return;
    const titlePlan = String(plan || 'starter').toUpperCase();
    const amountStr = typeof amountTl === 'number' ? amountTl.toFixed(2).replace('.', ',') : String(amountTl);
    const subject = `Ödemeniz alındı: ${titlePlan} plan`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>Teşekkürler!</h2>
        <p>${titlePlan} plan için ödemeniz başarıyla alındı.</p>
        <p><strong>Tutar:</strong> ${amountStr} TL</p>
        <p><strong>Sipariş No:</strong> ${oid}</p>
        <p>Hesabınızda abonelik durumunu görüntülemek için <a href="https://konuskonusabilirsen.com/account.html">Hesabım</a> sayfasını ziyaret edebilirsiniz.</p>
        <hr/>
        <p>Herhangi bir sorunuz olursa bu e-postayı yanıtlayabilirsiniz.</p>
      </div>`;
    const { error } = await resend.emails.send({ from: MAIL_FROM, to, subject, html });
    if (error) console.warn('[resend] payment-success email error:', error);
  } catch (e){ console.warn('[resend] payment-success send error:', e); }
}

// Request password reset link
app.post('/auth/forgot', [body('email').isEmail()], async (req, res) => {
  try {
    const vr = validationResult(req);
    if (!vr.isEmpty()) return res.status(400).json({ error: 'invalid_input' });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'invalid_input' });
    const lower = String(email).toLowerCase();
    const token = randToken(16);
    const expires = new Date(Date.now() + 60*60*1000); // 1 saat
    await User.findOneAndUpdate({ email: lower }, { $set: { resetToken: token, resetExpires: expires } });
    const url = `${req.protocol}://${req.get('host')}/reset.html?token=${token}`;
    if (resend) {
      const { data, error } = await resend.emails.send({
        from: MAIL_FROM,
        to: lower,
        subject: 'Şifre Sıfırlama - KonusKonusabilirsen',
        html: `<p>Şifrenizi sıfırlamak için aşağıdaki bağlantıya tıklayın:</p><p><a href="${url}">${url}</a></p><p>Bağlantı 1 saat geçerlidir.</p>`
      });
      if (error) { console.error('[resend] forgot email error:', error); }
      else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
    } else {
      console.log(`[mail] Şifre sıfırlama (${lower}): ${url}`);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Perform password reset
app.post('/auth/reset', [body('token').isString().notEmpty(), body('password').isString().isLength({ min: 6 })], async (req, res) => {
  try {
    const vr = validationResult(req);
    if (!vr.isEmpty()) return res.status(400).json({ error: 'invalid_input' });
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 6) return res.status(400).json({ error: 'invalid_input' });
    const user = await User.findOne({ resetToken: token, resetExpires: { $gt: new Date() } });
    if (!user) return res.status(400).json({ error: 'invalid_or_expired' });
    user.passwordHash = await bcrypt.hash(String(password), 10);
    user.resetToken = null; user.resetExpires = null;
    await user.save();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Request email verification link
app.post('/auth/verify/request', authRequired, async (req, res) => {
  try {
    const token = randToken(16);
    const expires = new Date(Date.now() + 24*60*60*1000); // 24 saat
    await User.findByIdAndUpdate(req.auth.uid, { $set: { verifyToken: token, verifyExpires: expires } });
    const url = `${req.protocol}://${req.get('host')}/verify.html?token=${token}`;
    if (resend) {
      console.log(`[resend] sending verify email to ${req.auth.email} (authed request)`);
      const { data, error } = await resend.emails.send({
        from: MAIL_FROM,
        to: req.auth.email,
        subject: 'E-posta Doğrulama - KonusKonusabilirsen',
        html: `<p>E-posta adresinizi doğrulamak için bağlantıya tıklayın:</p><p><a href="${url}">${url}</a></p><p>Bağlantı 24 saat geçerlidir.</p>`
      });
      if (error) { console.error('[resend] verify email error:', error); }
      else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
    } else {
      console.log(`[mail] E-posta doğrulama (${req.auth.email}): ${url}`);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Confirm email verification
app.post('/auth/verify', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{16,64}$/i.test(token)){
      return res.status(400).json({ error: 'invalid_input' });
    }
    const now = new Date();
    const user = await User.findOne({ verifyToken: token, verifyExpires: { $gt: now } });
    if (!user){
      console.warn('[auth/verify] token not found or expired:', maskToken(token));
      return res.status(400).json({ error: 'invalid_or_expired' });
    }
    user.emailVerified = true;
    user.verifyToken = null; user.verifyExpires = null;
    await user.save();
    const jwtToken = jwt.sign({ uid: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token: jwtToken, user: { id: String(user._id), email: user.email } });
  } catch (e) {
    console.error('[auth/verify] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Also support GET /auth/verify?token=... for direct link flows
app.get('/auth/verify', async (req, res) => {
  try {
    const token = String(req.query?.token || '');
    if (!/^[a-f0-9]{16,64}$/i.test(token)){
      return res.status(400).json({ error: 'invalid_input' });
    }
    const user = await User.findOne({ verifyToken: token, verifyExpires: { $gt: new Date() } });
    if (!user){
      console.warn('[auth/verify GET] token not found or expired:', maskToken(token));
      return res.status(400).json({ error: 'invalid_or_expired' });
    }
    user.emailVerified = true;
    user.verifyToken = null; user.verifyExpires = null;
    await user.save();
    const jwtToken = jwt.sign({ uid: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token: jwtToken, user: { id: String(user._id), email: user.email } });
  } catch (e) {
    console.error('[auth/verify GET] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Subscription (placeholders) — to be wired to Stripe later
app.post('/api/checkout/session', async (req, res) => {
  // In the future we will create a Stripe Checkout Session here
  return res.status(501).json({ error: 'not_implemented', hint: 'Stripe entegrasyonu henüz aktif değil. STRIPE_SECRET_KEY ve PRICE_ID ayarlayın.' });
});

app.post('/api/billing/portal', async (req, res) => {
  // In the future we will create a Stripe Billing Portal session here
  return res.status(501).json({ error: 'not_implemented', hint: 'Stripe faturalandırma portalı yakında eklenecek.' });
});

// ---- PayTR Hosted Checkout ----
function getClientIp(req){
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}

app.post('/api/paytr/checkout', authRequired, async (req, res) => {
  try{
    if (!PAYTR_MERCHANT_ID || !PAYTR_MERCHANT_KEY || !PAYTR_MERCHANT_SALT){
      return res.status(500).json({ error: 'paytr_not_configured' });
    }
    const { plan = 'starter' } = req.body || {};
    // Prices (TRY) -> PayTR wants kuruş (integer)
    const priceMap = { economy: 199.00, starter: 399.00, pro: 999.00 };
    const price = priceMap[String(plan)] ?? priceMap.starter;
    const payment_amount = Math.round(price * 100); // kuruş

    const merchant_oid = `hk${uuidv4().replace(/-/g,'')}`;
    const user_ip = getClientIp(req);
    const email = req.auth?.email || 'test@example.com';
    const user_name = 'Hemen Konus';
    const user_address = 'İstanbul';
    const user_phone = '+905555555555';
    const currency = 'TL';
    const test_mode = Number(process.env.PAYTR_TEST_MODE ?? (NODE_ENV === 'production' ? 0 : 1)); // 0=live, 1=test
    const non_3d = 0;
    const timeout_limit = 10;
    const no_installment = 1;
    const max_installment = 1;
    const installment_count = 0;
    const lang = 'tr';

    const basket = [[`KonusKonusabilirsen ${String(plan).toUpperCase()} Planı`, price.toFixed(2), 1]];
    const user_basket = Buffer.from(JSON.stringify(basket)).toString('base64');

    // Generate token
    const hash_str = `${PAYTR_MERCHANT_ID}${user_ip}${merchant_oid}${email}${payment_amount}${user_basket}${no_installment}${max_installment}${currency}${test_mode}`;
    const paytr_token = crypto.createHmac('sha256', PAYTR_MERCHANT_KEY)
      .update(hash_str + PAYTR_MERCHANT_SALT, 'utf8')
      .digest('base64');

    // Use main domain for callbacks
    const baseUrl = 'https://konuskonusabilirsen.com';
    const merchant_ok_url = `${baseUrl}/success.html`;
    const merchant_fail_url = `${baseUrl}/?payment=failed`;
    
    const form = new URLSearchParams({
      merchant_id: PAYTR_MERCHANT_ID,
      user_ip,
      merchant_oid,
      email,
      payment_amount: String(payment_amount),
      user_basket,
      no_installment: String(no_installment),
      max_installment: String(max_installment),
      currency,
      test_mode: String(test_mode),
      non_3d: String(non_3d),
      merchant_ok_url,
      merchant_fail_url,
      timeout_limit: String(timeout_limit),
      debug_on: '1',
      lang,
      user_name,
      user_address,
      user_phone,
      paytr_token
    });

    let fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') fetchFn = (await import('node-fetch')).default;

    const r = await fetchFn('https://www.paytr.com/odeme/api/get-token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
    });
    const data = await r.json().catch(async () => ({ status: 'error', reason: await r.text() }));
    if (data.status !== 'success'){
      console.error('[paytr] get-token error:', { data, test_mode, currency, merchant_oid, email, amount: payment_amount });
      return res.status(500).json({ error: 'paytr_error', detail: data.reason || 'unknown', test_mode });
    }
    // Persist pending payment in DB for cross-instance reliability
    try {
      await Payment.create({
        provider: 'paytr',
        merchant_oid,
        uid: req.auth.uid,
        plan,
        status: 'pending',
      });
      console.log(`[paytr] Payment pending saved to DB for merchant_oid: ${merchant_oid}`, { uid: req.auth.uid, plan });
    } catch (dbErr) {
      console.error('[paytr] Failed to create Payment record (may already exist):', dbErr?.message || dbErr);
    }
    const token = data.token;
    const iframe_url = `https://www.paytr.com/odeme/guvenli/${token}`;
    return res.json({ token, iframe_url });
  }catch(e){
    console.error('[paytr] checkout error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// PayTR callback
// Debug: Track callback invocations
let callbackInvocations = [];

app.post('/paytr/callback', express.urlencoded({ extended: false }), async (req, res) => {
  const callbackId = `cb_${Date.now()}`;
  const startTime = Date.now();
  
  const logEntry = {
    id: callbackId,
    timestamp: new Date().toISOString(),
    body: { ...req.body },
    status: 'started',
    headers: req.headers,
    ip: req.ip
  };
  
  // Store only last 20 invocations
  callbackInvocations = [logEntry, ...callbackInvocations].slice(0, 20);
  
  console.log(`[${callbackId}] PayTR callback received`, {
    merchant_oid: req.body.merchant_oid,
    status: req.body.status,
    payment_status: req.body.payment_status
  });
  
  // Always respond with OK to prevent retries
  const sendOk = () => {
    logEntry.status = 'completed';
    logEntry.durationMs = Date.now() - startTime;
    logEntry.completedAt = new Date().toISOString();
    console.log(`[${callbackId}] Sending OK response`);
    res.end('OK');
  };
  
  try {
    console.log(`[paytr][${callbackId}] Callback received:`, JSON.stringify(req.body, null, 2));
    console.log('[paytr] Received callback with body:', JSON.stringify(req.body));
    const {
      merchant_oid = '', status = '', total_amount = '', hash = '', payment_status = ''
    } = req.body || {};
    // Verify hash
    const hash_str = `${merchant_oid}${PAYTR_MERCHANT_SALT}${status}${total_amount}`;
    const calc = crypto.createHmac('sha256', PAYTR_MERCHANT_KEY).update(hash_str, 'utf8').digest('base64');
    if (calc !== hash){
      console.error('[paytr] invalid hash for oid', merchant_oid);
      return res.end('OK'); // must respond OK regardless
    }
    const isSuccess = status === 'success' || payment_status === 'success';
    logEntry.isSuccess = isSuccess;
    logEntry.paymentStatus = { status, payment_status };
    
    if (isSuccess) {
      console.log(`[paytr] Processing successful payment for merchant_oid: ${merchant_oid}`);
      // Find Payment from DB
      const pay = await Payment.findOne({ merchant_oid }).lean();
      logEntry.paymentDocFound = !!pay;
      if (!pay) {
        console.error(`[paytr] Payment doc not found for merchant_oid: ${merchant_oid}`);
        return sendOk();
      }
      // Idempotency: if already success, do nothing
      if (pay.status === 'success') {
        console.log(`[paytr] Payment already processed for merchant_oid: ${merchant_oid}`);
        return sendOk();
      }
      const sess = { uid: pay.uid, plan: pay.plan };
      logEntry.sessionData = sess;
      console.log(`[paytr] Updating user ${sess.uid} to plan ${sess.plan}`);
      
      try {
        // Calculate subscription end date (1 month from now)
        const currentDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);

        // First, cancel any existing active subscription
        await Subscription.updateMany(
          { 
            userId: sess.uid,
            status: 'active',
            plan: { $ne: sess.plan } // Only update if the plan is different
          },
          { 
            $set: { 
              status: 'cancelled',
              cancelledAt: currentDate,
              updatedAt: new Date()
            }
          }
        );

        // Then create or update the new subscription
        await Subscription.findOneAndUpdate(
          { 
            userId: sess.uid,
            plan: sess.plan,
            status: { $ne: 'cancelled' }
          },
          { 
            $set: { 
              plan: sess.plan,
              status: 'active',
              currentPeriodStart: currentDate,
              currentPeriodEnd: endDate,
              updatedAt: new Date(),
              // Reset these fields when changing plans
              cancelledAt: null,
              cancellationReason: null
            },
            $setOnInsert: { 
              createdAt: new Date()
            }
          },
          { 
            upsert: true, 
            new: true 
          }
        );

        // Reset usage for the new plan
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        // Update user's plan, set limits and reset usage
        console.log(`[paytr] Updating user ${sess.uid} to plan ${sess.plan}`);
        console.log(`[paytr] New limits - daily: ${getPlanLimit(sess.plan, 'daily')}, monthly: ${getPlanLimit(sess.plan, 'monthly')}`);
        
        const updateData = { 
          $set: { 
            plan: sess.plan,
            planUpdatedAt: now,
            // Set plan limits and reset usage
            'usage.dailyLimit': getPlanLimit(sess.plan, 'daily'),
            'usage.monthlyLimit': getPlanLimit(sess.plan, 'monthly'),
            'usage.dailyUsed': 0,
            'usage.monthlyUsed': 0,
            'usage.lastReset': now,
            'usage.monthlyResetAt': startOfMonth
          } 
        };
        
        logEntry.updateData = updateData;
        console.log(`[${callbackId}] Updating user ${sess.uid} with:`, JSON.stringify(updateData, null, 2));
        
        const updateResult = await User.findByIdAndUpdate(
          sess.uid, 
          updateData,
          { new: true, runValidators: true }
        );
        
        logEntry.updateResult = updateResult ? 'success' : 'failed';
        logEntry.updatedUser = updateResult;
        
        console.log(`[paytr] User update result:`, updateResult ? 'Success' : 'Failed');
        if (updateResult) {
          console.log(`[paytr] User ${sess.uid} plan updated to ${sess.plan}`);
          // Mark payment as success in DB
          try {
            await Payment.updateOne(
              { merchant_oid },
              { $set: { status: 'success', total_amount: Number(total_amount) || null, paidAt: new Date(), raw: req.body } }
            );
          } catch (e) {
            console.error('[paytr] Failed to update Payment doc to success:', e);
          }
        } else {
          console.error(`[paytr] Failed to update user ${sess.uid}`);
        }
        
        // Also update the Usage collection
        await Usage.updateOne(
          { userId: sess.uid },
          { 
            $set: {
              'daily.used': 0,
              'monthly.used': 0,
              'daily.resetAt': now,
              'monthly.resetAt': startOfMonth,
              updatedAt: now
            },
            $setOnInsert: { 
              userId: sess.uid,
              createdAt: now
            }
          },
          { upsert: true }
        );

        // Send email notification (best-effort)
        try {
          const userDoc = await User.findById(sess.uid).lean();
          const email = userDoc?.email || null;
          const amountTl = Number(total_amount) / 100;
          if (email) {
            await sendPaymentSuccessEmail(email, { 
              plan: sess.plan, 
              amountTl, 
              oid: merchant_oid 
            });
            console.log(`[paytr] Success email sent to ${email} for plan ${sess.plan}`);
          } else {
            console.warn(`[paytr] No email found for user ${sess.uid}`);
          }
        } catch (e) { 
          console.warn('[paytr] Email notification error:', e?.message || e); 
        }
        
        console.log(`[paytr] Successfully updated user ${sess.uid} to plan ${sess.plan}`);
      } catch (e) {
        console.error(`[paytr] Error updating user ${sess.uid} to plan ${sess.plan}:`, e);
        // Don't remove from pending so we can retry
        return res.end('OK');
      }
      
      // If not successful or early return, still attempt to mark failure
    } else {
      try {
        await Payment.updateOne(
          { merchant_oid },
          { $set: { status: 'failed', raw: req.body } }
        );
      } catch (e) {
        console.error('[paytr] Failed to update Payment doc to failed:', e);
      }
    }
    // Log the completion
    logEntry.status = 'completed';
    logEntry.completedAt = new Date().toISOString();
    
    return sendOk();
  } catch(e) {
    const errorMsg = e?.message || String(e);
    logEntry.error = errorMsg;
    logEntry.status = 'error';
    logEntry.stack = e?.stack;
    
    console.error(`[${callbackId}] Error:`, errorMsg);
    if (e?.stack) {
      console.error(`[${callbackId}] Stack:`, e.stack);
    }
    return sendOk();
  }
});

// ---- Iyzico basic checkout (sandbox-friendly) ----
function getIyzico() {
  if (!IYZICO_API_KEY || !IYZICO_SECRET_KEY) return null;
  return new Iyzipay({ apiKey: IYZICO_API_KEY, secretKey: IYZICO_SECRET_KEY, uri: IYZICO_BASE_URL });
}

// Debug endpoint to check recent callback invocations
app.get('/api/debug/paytr-callbacks', (req, res) => {
  return res.json(callbackInvocations);
});

// Debug: list recent payments
app.get('/api/debug/payments', async (req, res) => {
  try {
    const { limit = 20 } = req.query || {};
    const lmt = Math.max(1, Math.min(100, Number(limit) || 20));
    const items = await Payment.find({}).sort({ createdAt: -1 }).limit(lmt).lean();
    return res.json({ items });
  } catch (e) {
    console.error('[debug/payments] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Debug: reprocess a PayTR payment by merchant_oid (idempotent)
app.post('/api/debug/paytr/reprocess', authRequired, async (req, res) => {
  try {
    const { merchant_oid } = req.body || {};
    if (!merchant_oid) return res.status(400).json({ error: 'invalid_input', message: 'merchant_oid gerekli' });
    const pay = await Payment.findOne({ merchant_oid });
    if (!pay) return res.status(404).json({ error: 'not_found' });
    if (pay.status !== 'success') {
      return res.status(400).json({ error: 'not_success', message: `Durum: ${pay.status}` });
    }
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const updateData = {
      $set: {
        plan: pay.plan,
        planUpdatedAt: now,
        'usage.dailyLimit': getPlanLimit(pay.plan, 'daily'),
        'usage.monthlyLimit': getPlanLimit(pay.plan, 'monthly'),
        'usage.dailyUsed': 0,
        'usage.monthlyUsed': 0,
        'usage.lastReset': now,
        'usage.monthlyResetAt': startOfMonth
      }
    };
    const result = await User.findByIdAndUpdate(pay.uid, updateData, { new: true, runValidators: true });
    if (!result) return res.status(404).json({ error: 'user_not_found' });
    return res.json({ ok: true, plan: result.plan, userId: String(result._id) });
  } catch (e) {
    console.error('[debug/paytr/reprocess] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Debug endpoint to check pending payments
app.get('/api/debug/pending-payments', (req, res) => {
  return res.json({
    paytrPending: Array.from(iyzPending.entries()).map(([key, value]) => ({
      merchant_oid: key,
      ...value,
      timestamp: value.timestamp?.toISOString()
    }))
  });
});

// Track pending Iyzico checkouts: conversationId -> { uid, plan }
const iyzPending = new Map();

// Create a checkout form for a selected plan. Requires auth.
app.post('/api/iyzico/checkout', authRequired, async (req, res) => {
  try {
    const iyz = getIyzico();
    if (!iyz) return res.status(500).json({ error: 'iyzico_not_configured' });
    const { plan = 'pro' } = req.body || {};
    // Minimal pricing for sandbox
    const priceMap = { economy: '199.00', starter: '399.00', pro: '999.00' };
    const price = priceMap[String(plan)] || priceMap.pro;

    // Callback URL (Iyzico will POST here after payment; we will redirect user to success/cancel pages)
    const callbackUrl = `${req.protocol}://${req.get('host')}/iyzico/callback`;

    const conversationId = uuidv4();
    const request = {
      locale: 'tr',
      conversationId,
      price,
      paidPrice: price,
      currency: Iyzipay.CURRENCY.TRY,
      basketId: `plan_${plan}`,
      paymentGroup: Iyzipay.PAYMENT_GROUP.SUBSCRIPTION, // indicative; single charge demo
      callbackUrl,
      enabledInstallments: [2,3,6,9],
      buyer: {
        id: req.auth?.uid || 'guest',
        name: 'Hemen',
        surname: 'Konus',
        gsmNumber: '+905555555555',
        email: req.auth?.email || 'test@example.com',
        identityNumber: '11111111110',
        lastLoginDate: new Date().toISOString().slice(0,19).replace('T',' '),
        registrationDate: new Date().toISOString().slice(0,19).replace('T',' '),
        registrationAddress: 'İstanbul',
        ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
        city: 'İstanbul',
        country: 'Türkiye',
        zipCode: '34000',
      },
      shippingAddress: {
        contactName: 'Hemen Konus',
        city: 'İstanbul',
        country: 'Türkiye',
        address: 'İstanbul',
        zipCode: '34000',
      },
      billingAddress: {
        contactName: 'Hemen Konus',
        city: 'İstanbul',
        country: 'Türkiye',
        address: 'İstanbul',
        zipCode: '34000',
      },
      basketItems: [
        {
          id: `plan_${plan}`,
          name: `KonusKonusabilirsen ${String(plan).toUpperCase()} Planı`,
          category1: 'Abonelik',
          itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
          price,
        },
      ],
    };

    iyz.checkoutFormInitialize.create(request, (err, result) => {
      if (err) {
        console.error('[iyzico] error:', err);
        return res.status(500).json({ error: 'iyzico_error', detail: err?.errorMessage || String(err) });
      }
      // Remember mapping for callback resolution
      iyzPending.set(conversationId, { uid: req.auth.uid, plan });
      // result.checkoutFormContent is Base64-encoded HTML; paymentPageUrl may also be present
      const html = result?.checkoutFormContent;
      const paymentPageUrl = result?.paymentPageUrl;
      return res.json({ html, paymentPageUrl, token: result?.token, conversationId });
    });
  } catch (e) {
    console.error('[iyzico] checkout error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Iyzico callback endpoint
app.post('/iyzico/callback', express.urlencoded({ extended: true }), (req, res) => {
  const { token, status } = req.body || {};
  if (!token) return res.redirect('/cancel.html');
  const iyz = getIyzico();
  if (!iyz) return res.redirect('/cancel.html');
  iyz.checkoutFormRetrieve.retrieve({ token }, async (err, result) => {
    if (err) {
      console.error('[iyzico] retrieve error:', err);
      return res.redirect('/cancel.html');
    }
    if (result?.paymentStatus === 'SUCCESS' || result?.status === 'success') {
      try {
        const convId = result?.conversationId;
        const sess = convId ? iyzPending.get(convId) : null;
        if (sess && sess.uid) {
          // Upsert a simple active subscription record
          const now = new Date();
          await Subscription.findOneAndUpdate(
            { userId: sess.uid, plan: sess.plan },
            {
              $set: {
                status: 'active',
                currentPeriodEnd: null,
                stripeCustomerId: null,
                stripeSubId: null,
              },
              $setOnInsert: { createdAt: now }
            },
            { upsert: true }
          );
        }
        if (convId) iyzPending.delete(convId);
      } catch (e) {
        console.error('[iyzico] subscription upsert error:', e);
      }
      return res.redirect('/success.html');
    }
    return res.redirect('/cancel.html');
  });
});

// Usage summary for current user (daily/monthly)
app.get('/usage', authRequired, async (req, res) => {
  try {
    const { month, from, to } = req.query || {};
    const now = new Date();
    const y = now.getFullYear();
    const mth = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dateBucket = `${y}-${mth}-${d}`;
    const monthBucket = month && /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : `${y}-${mth}`;

    // Daily (today)
    const dayDoc = await Usage.findOne({ userId: req.auth.uid, dateBucket }).lean();

    // Monthly or custom range aggregation
    let match = { userId: new mongoose.Types.ObjectId(req.auth.uid) };
    if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(String(from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
      match = { ...match, dateBucket: { $gte: String(from), $lte: String(to) } };
    } else {
      match = { ...match, monthBucket };
    }
    const monthAgg = await Usage.aggregate([
      { $match: match },
      { $group: { _id: null, minutes: { $sum: '$minutes' } } }
    ]);
    const usedDaily = dayDoc?.minutes || 0;
    const usedMonthly = monthAgg?.[0]?.minutes || 0;
    // Determine plan: prefer User.plan, fallback to active Subscription
    const userDoc = await User.findById(req.auth.uid).lean();
    let plan = userDoc?.plan || null;
    if (!plan) {
      const sub = await Subscription.findOne({ userId: req.auth.uid, status: 'active' }).lean();
      plan = sub?.plan || 'free';
    }
    // Limits via helper
    const limits = { daily: getPlanLimit(plan, 'daily'), monthly: getPlanLimit(plan, 'monthly') };
    return res.json({ plan, usedDaily, usedMonthly, limits, range: { month: monthBucket, from: from || null, to: to || null } });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Gamification summary (streak / goal / achievements)
app.get('/gamification/summary', authRequired, async (req, res) => {
  try {
    const uid = req.auth.uid;
    const now = new Date();
    const y = now.getFullYear();
    const mth = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dateBucket = `${y}-${mth}-${d}`;

    const [streak, goal, achs, dayDoc] = await Promise.all([
      Streak.findOne({ userId: uid }).lean(),
      Goal.findOne({ userId: uid }).lean(),
      Achievement.find({ userId: uid }).lean(),
      Usage.findOne({ userId: uid, dateBucket }).lean(),
    ]);
    const usedDaily = dayDoc?.minutes || 0;
    res.json({
      streak: { count: streak?.count || 0, lastDay: streak?.lastDay || null },
      goal: { dailyMinutes: goal?.dailyMinutes ?? 10, lastMetDate: goal?.lastMetDate || null, usedDaily },
      achievements: (achs || []).map(a => ({ key: a.key, unlockedAt: a.unlockedAt }))
    });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Daily challenge: get completion status for today
app.get('/daily/status', authRequired, async (req, res) => {
  try{
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    const dateBucket = `${y}-${m}-${d}`;
    const [doc, goal, streak] = await Promise.all([
      DailyChallenge.findOne({ userId: req.auth.uid, dateBucket }).lean(),
      Goal.findOne({ userId: req.auth.uid }).lean(),
      Streak.findOne({ userId: req.auth.uid }).lean(),
    ]);
    const resetAt = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 0, 0);
    return res.json({ completed: !!doc, scenarioId: doc?.scenarioId || null, minutes: doc?.minutes || 0, completedAt: doc?.completedAt || null, goal: goal?.dailyMinutes ?? 10, streak: streak?.count || 0, resetAt: resetAt.toISOString() });
  }catch(e){
    return res.status(500).json({ error: 'server_error' });
  }
});

// Daily challenge: mark as completed (idempotent per day)
app.post('/daily/complete', authRequired, async (req, res) => {
  try{
    const { scenarioId, minutes } = req.body || {};
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    const dateBucket = `${y}-${m}-${d}`;
    const existing = await DailyChallenge.findOne({ userId: req.auth.uid, dateBucket }).lean();
    let doc;
    let streakIncremented = false;
    let streakCount = 0;
    if (!existing){
      doc = await DailyChallenge.findOneAndUpdate(
        { userId: req.auth.uid, dateBucket },
        { $setOnInsert: { completedAt: new Date() }, $set: { scenarioId: scenarioId || null, minutes: Number(minutes)||0 } },
        { new: true, upsert: true }
      );
      // Update streak
      const today = dateBucket;
      const yest = (() => {
        const t = new Date(now.getTime() - 24*60*60*1000);
        const yy = t.getFullYear(); const mm = String(t.getMonth()+1).padStart(2,'0'); const dd = String(t.getDate()).padStart(2,'0');
        return `${yy}-${mm}-${dd}`;
      })();
      const s = await Streak.findOne({ userId: req.auth.uid }).lean();
      if (!s){
        const ns = await Streak.findOneAndUpdate(
          { userId: req.auth.uid },
          { $set: { lastDay: today }, $setOnInsert: { count: 1 } },
          { new: true, upsert: true }
        );
        streakIncremented = true; streakCount = 1;
      } else if (s.lastDay === today){
        streakCount = s.count;
      } else if (s.lastDay === yest){
        const ns = await Streak.findOneAndUpdate(
          { userId: req.auth.uid },
          { $set: { lastDay: today }, $inc: { count: 1 } },
          { new: true }
        );
        streakIncremented = true; streakCount = ns?.count || (s.count+1);
      } else {
        const ns = await Streak.findOneAndUpdate(
          { userId: req.auth.uid },
          { $set: { lastDay: today, count: 1 } },
          { new: true, upsert: true }
        );
        streakIncremented = true; streakCount = 1;
      }
      // Simple achievements for streak milestones (best effort)
      try{
        const milestones = [3,7,30];
        for (const k of milestones){
          if (streakCount >= k){
            await Achievement.updateOne(
              { userId: req.auth.uid, key: `streak_${k}` },
              { $setOnInsert: { unlockedAt: new Date() } },
              { upsert: true }
            );
          }
        }
      }catch{}
    } else {
      doc = existing;
      const s = await Streak.findOne({ userId: req.auth.uid }).lean();
      streakCount = s?.count || 0;
    }
    return res.json({ ok: true, completed: true, dateBucket, scenarioId: doc.scenarioId, minutes: doc.minutes, streakIncremented, streakCount });
  }catch(e){
    return res.status(500).json({ error: 'server_error' });
  }
});

// Journal: save today's note
app.post('/journal', authRequired, async (req, res) => {
  try{
    const { note } = req.body || {};
    if (typeof note !== 'string' || note.length > 2000){ return res.status(400).json({ error: 'invalid_note' }); }
    const now = new Date();
    const y = now.getFullYear(); const m = String(now.getMonth()+1).padStart(2,'0'); const d = String(now.getDate()).padStart(2,'0');
    const dateBucket = `${y}-${m}-${d}`;
    await User.updateOne({ _id: req.auth.uid }, { $set: { [`journal.${dateBucket}`]: note } });
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: 'server_error' }); }
});

// Journal: get last 7 days
app.get('/journal', authRequired, async (req, res) => {
  try{
    const user = await User.findById(req.auth.uid).lean();
    const j = user?.journal || {};
    return res.json({ items: j });
  }catch(e){ return res.status(500).json({ error: 'server_error' }); }
});

// Set/Update daily goal
app.patch('/gamification/goal', authRequired, async (req, res) => {
  try {
    const { dailyMinutes } = req.body || {};
    const n = Number(dailyMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 300) {
      return res.status(400).json({ error: 'invalid_input', message: 'dailyMinutes 1-300 arası olmalıdır.' });
    }
    const doc = await Goal.findOneAndUpdate(
      { userId: req.auth.uid },
      { $set: { dailyMinutes: Math.round(n) } },
      { new: true, upsert: true }
    );
    return res.json({ ok: true, goal: { dailyMinutes: doc.dailyMinutes, lastMetDate: doc.lastMetDate || null } });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Ephemeral token for OpenAI Realtime WebRTC
// Creates a short-lived client token that can be used by the client to connect directly to OpenAI via WebRTC.
app.post('/realtime/ephemeral', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'missing_openai_api_key' });
    }
    // Prefer native fetch (Node 18+). Fallback to node-fetch only if necessary.
    let fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      try {
        fetchFn = (await import('node-fetch')).default;
      } catch (e) {
        console.error('[ephemeral] fetch unavailable and node-fetch not installed');
        return res.status(500).json({ error: 'fetch_unavailable', hint: 'Use Node 18+ or install node-fetch' });
      }
    }
    const model = req.body?.model || process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    // Optionally accept language/correction hints from body for anonymous demos
    const learnLang = (req.body?.preferredLearningLanguage || req.body?.preferredLanguage || 'tr').toLowerCase();
    const nativeLang = (req.body?.preferredNativeLanguage || 'tr').toLowerCase();
    const corr = (req.body?.preferredCorrectionMode || 'gentle').toLowerCase();
    const persona = buildPersonaInstruction(learnLang, nativeLang, corr);
    const r = await fetchFn('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({
        model,
        modalities: ['audio','text'],
        voice: 'alloy',
        instructions: persona,
        max_response_output_tokens: 480,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.25,
          prefix_padding_ms: 200,
          silence_duration_ms: 400,
          create_response: true,
          interrupt_response: true
        }
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[ephemeral] OpenAI error:', txt);
      return res.status(500).json({ error: 'openai_error', detail: txt });
    }
    const json = await r.json();
    // Return only what's needed by the client
    return res.json({
      model,
      client_secret: json?.client_secret?.value || null,
      expires_at: json?.client_secret?.expires_at || null,
    });
  } catch (e) {
    console.error('[ephemeral] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// In-memory session store (v0)
// session: { plan, createdAt, minutesUsedDaily, minutesUsedMonthly, limits: { daily, monthly }, userId, prefs: { learnLang, nativeLang, voice, correction }, userLevel }
const sessions = new Map();

// Realtime API endpoint (Azure or OpenAI)
const OPENAI_REALTIME_URL = USE_AZURE
  ? `${AZURE_OPENAI_ENDPOINT.replace(/^http/, 'ws')}/openai/realtime?api-version=${AZURE_OPENAI_API_VERSION}&deployment=${AZURE_OPENAI_DEPLOYMENT}`
  : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;

// Start session
app.post('/session/start', async (req, res) => {
  const { plan: _ignoredPlan = 'free' } = req.body || {};
  // Optional auth: extract uid/email if Authorization provided
  let uid = null, email = null;
  try {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)/i.exec(h);
    if (m) {
      const payload = jwt.verify(m[1], JWT_SECRET);
      uid = String(payload.uid);
      email = payload.email || null;
    }
  } catch {}
  // Enforce auth for realtime sessions (free demo dahil):
  if (!uid) {
    return res.status(401).json({ error: 'auth_required', message: 'Lütfen giriş yapın ve tekrar deneyin.' });
  }
  // Enforce placement completion before allowing realtime session
  try {
    const userDoc = await User.findById(uid).lean();
    if (!userDoc) return res.status(401).json({ error: 'auth_required' });
    if (!userDoc.placementLevel) {
      return res.status(403).json({ error: 'placement_required', message: 'Lütfen seviye belirleme testini tamamlayın.' });
    }
  } catch {}
  const sessionId = uuidv4();
  const createdAt = Date.now();
  // Determine effective plan from user profile (do NOT trust client body)
  let effectivePlan = 'free';
  try {
    const u = await User.findById(uid).lean();
    if (u && u.plan) effectivePlan = String(u.plan);
  } catch {}
  // minute limits per plan
  const limits = {
    daily: getPlanLimit(String(effectivePlan), 'daily'),
    monthly: getPlanLimit(String(effectivePlan), 'monthly')
  };
  // Load user prefs if available
  let prefs = { learnLang: 'tr', nativeLang: 'tr', voice: 'alloy', correction: 'gentle', scenarioId: null };
  let userLevel = null;
  try {
    if (uid) {
      const u = await User.findById(uid).lean();
      if (u) {
        if (u.preferredLearningLanguage) prefs.learnLang = String(u.preferredLearningLanguage).toLowerCase();
        if (u.preferredNativeLanguage) prefs.nativeLang = String(u.preferredNativeLanguage).toLowerCase();
        if (u.preferredVoice) prefs.voice = String(u.preferredVoice);
        if (u.preferredCorrectionMode) prefs.correction = String(u.preferredCorrectionMode).toLowerCase();
        if (u.placementLevel) userLevel = String(u.placementLevel);
      }
    }
  } catch {}
  // Kullanım verilerini /me endpoint'inden al
  let minutesUsedDaily = 0;
  let minutesUsedMonthly = 0;
  try {
    // ...
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const user = await User.findById(uid);
      if (user && user.usage) {
        // Günlük kullanımı sıfırla (eğer yeni bir gün başladıysa)
        const now = new Date();
        const lastReset = new Date(user.usage.lastReset);
        if (now.toDateString() !== lastReset.toDateString()) {
          user.usage.dailyUsed = 0;
          user.usage.lastReset = now;
          await user.save();
          minutesUsedDaily = 0;
        } else {
          minutesUsedDaily = user.usage.dailyUsed || 0;
        }

        // Aylık kullanımı sıfırla (eğer yeni bir ay başladıysa)
        const monthlyReset = new Date(user.usage.monthlyResetAt);
        if (now > monthlyReset) {
          user.usage.monthlyUsed = 0;
          user.usage.monthlyResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          await user.save();
          minutesUsedMonthly = 0;
        } else {
          minutesUsedMonthly = user.usage.monthlyUsed || 0;
        }

        console.log(`[DEBUG] /me usage'den yüklenen değerler - daily: ${minutesUsedDaily}, monthly: ${minutesUsedMonthly}`);
      }
    }
  } catch (e) {
    console.warn('[session] usage load error:', e?.message || e);
  }
  // If over limit, block session start
  if (minutesUsedDaily >= limits.daily || minutesUsedMonthly >= limits.monthly) {
    return res.status(403).json({ error: 'limit_reached', message: 'Kullanım limitiniz doldu.', minutesUsedDaily, minutesUsedMonthly, minutesLimitDaily: limits.daily, minutesLimitMonthly: limits.monthly, limits, plan: String(effectivePlan) });
  }
  const sessObj = { plan: String(effectivePlan), createdAt, minutesUsedDaily, minutesUsedMonthly, limits, userId: uid, prefs, userLevel };
  sessions.set(sessionId, sessObj);
  return res.json({ sessionId, wsUrl: `/realtime/ws?sessionId=${sessionId}`.replace('http','ws'), plan: String(effectivePlan), minutesLimitDaily: limits.daily, minutesLimitMonthly: limits.monthly, minutesUsedDaily, minutesUsedMonthly });
});

// Close session
app.post('/session/close', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: 'invalid_session' });
  }
  const s = sessions.get(sessionId);
  sessions.delete(sessionId);
  console.log('[session/close]', { sessionId, plan: s?.plan, usedDaily: s?.minutesUsedDaily, usedMonthly: s?.minutesUsedMonthly });
  res.json({ closed: true, usage: s });
});

// WebSocket proxy to OpenAI Realtime
const wss = new WebSocketServer({ server, path: '/realtime/ws' });

wss.on('connection', (clientWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId || !sessions.has(sessionId)) {
    console.log('[server] Client connection rejected: invalid session ID.');
    clientWs.close(1008, 'invalid_session');
    return;
  }

  if (!USE_AZURE && !OPENAI_API_KEY) {
    console.log('[server] Client connection rejected: OPENAI_API_KEY not set.');
    clientWs.close(1011, 'missing_api_key');
    return;
  }
  if (USE_AZURE && !AZURE_OPENAI_API_KEY) {
    console.log('[server] Client connection rejected: AZURE_OPENAI_API_KEY not set.');
    clientWs.close(1011, 'missing_api_key');
    return;
  }

  console.log(`[server] Client connected with session ID: ${sessionId}`);
  clientWs.send(JSON.stringify({ type: 'hello', sessionId }));
  const sess = sessions.get(sessionId);
  let speechStartTs = null;
  // Realtime duration tracking (from first audio_start)
  let realtimeTimer = null;
  let realtimeStartedAt = null;
  // Immediately inform client about current persisted usage to avoid showing 0/x on load
  try {
    if (sess) {
      clientWs.send(JSON.stringify({ type: 'usage_update', usage: { usedDaily: sess.minutesUsedDaily || 0, usedMonthly: sess.minutesUsedMonthly || 0, limits: sess.limits } }));
    }
  } catch {}
  // Safely add usage and persist + trigger gamification
  function addUsageFromSeconds(seconds){
    console.log(`[DEBUG] addUsageFromSeconds çağrıldı! seconds: ${seconds}, sess:`, sess ? 'var' : 'yok');
    try {
      const minutes = seconds / 60;
      console.log(`[DEBUG] addUsageFromSeconds: minutes: ${minutes}, sess.minutesUsedDaily: ${sess?.minutesUsedDaily}, sess.minutesUsedMonthly: ${sess?.minutesUsedMonthly}`);
      if (!sess || !minutes || minutes <= 0) return { over:false, usedDaily: sess?.minutesUsedDaily||0, usedMonthly: sess?.minutesUsedMonthly||0, limits: sess?.limits };
      sess.minutesUsedDaily = (sess.minutesUsedDaily || 0) + minutes;
      sess.minutesUsedMonthly = (sess.minutesUsedMonthly || 0) + minutes;
      console.log(`[DEBUG] addUsageFromSeconds: güncellendi - daily: ${sess.minutesUsedDaily}, monthly: ${sess.minutesUsedMonthly}`);
      const dOver = sess.minutesUsedDaily >= (sess.limits?.daily ?? Infinity);
      const mOver = sess.minutesUsedMonthly >= (sess.limits?.monthly ?? Infinity);
      // Persist usage aggregates (fire-and-forget)
      try {
        const now = new Date();
        const y = now.getFullYear();
        const mth = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const dateBucket = `${y}-${mth}-${d}`;
        const monthBucket = `${y}-${mth}`;
        console.log(`[DEBUG] addUsageFromSeconds: veritabanına kaydetmeye çalışıyor - userId: ${sess.userId}, dateBucket: ${dateBucket}, minutes: ${minutes}`);
        Usage.updateOne(
          { userId: new mongoose.Types.ObjectId(sess.userId), dateBucket, monthBucket },
          { $inc: { minutes } },
          { upsert: true }
        ).then(async (result) => {
          console.log(`[DEBUG] addUsageFromSeconds: veritabanı güncellemesi başarılı:`, result);

          // User.usage'yi de güncelle ki /me endpoint'i doğru değeri görsün
          try {
            await User.findByIdAndUpdate(sess.userId, {
              $inc: {
                'usage.dailyUsed': minutes,
                'usage.monthlyUsed': minutes
              }
            });
            console.log(`[DEBUG] addUsageFromSeconds: User.usage de güncellendi - minutes: ${minutes}`);
          } catch (userErr) {
            console.error(`[DEBUG] addUsageFromSeconds: User.usage güncelleme hatası:`, userErr);
          }
        }).catch(err => {
          console.error(`[DEBUG] addUsageFromSeconds: veritabanı güncellemesi hatası:`, err);
        });
      } catch (dbErr) {
        console.error(`[DEBUG] addUsageFromSeconds: veritabanı hatası:`, dbErr);
      }
      // Gamification hooks (best-effort)
      try {
        const now = new Date();
        const y = now.getFullYear();
        const mth = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const today = `${y}-${mth}-${d}`;
        (async () => {
          try {
            // Streak
            const s = await Streak.findOne({ userId: sess.userId });
            if (!s) {
              await Streak.create({ userId: sess.userId, lastDay: today, count: 1 });
            } else if (s.lastDay !== today) {
              const yst = new Date(now.getTime() - 24*60*60*1000);
              const ystStr = `${yst.getFullYear()}-${String(yst.getMonth()+1).padStart(2,'0')}-${String(yst.getDate()).padStart(2,'0')}`;
              s.count = (s.lastDay === ystStr) ? (s.count + 1) : 1;
              s.lastDay = today;
              await s.save();
            }
            // Goal
            const goal = await Goal.findOneAndUpdate(
              { userId: sess.userId },
              { $setOnInsert: { dailyMinutes: 10, lastMetDate: null } },
              { new: true, upsert: true }
            );
            if (goal && sess.minutesUsedDaily >= (goal.dailyMinutes || 10) && goal.lastMetDate !== today){
              goal.lastMetDate = today; await goal.save();
              await Achievement.updateOne(
                { userId: sess.userId, key: 'daily_goal_met' },
                { $setOnInsert: { unlockedAt: new Date() } },
                { upsert: true }
              );
            }
            // Streak achievements
            const st = await Streak.findOne({ userId: sess.userId });
            const thresholds = [3, 7, 30];
            for (const t of thresholds){
              if (st && st.count >= t){
                await Achievement.updateOne(
                  { userId: sess.userId, key: `streak_${t}` },
                  { $setOnInsert: { unlockedAt: new Date() } },
                  { upsert: true }
                );
              }
            }
          } catch {}
        })();
      } catch {}
      return { over: dOver || mOver, dOver, mOver, usedDaily: sess.minutesUsedDaily, usedMonthly: sess.minutesUsedMonthly, limits: sess.limits };
    } catch (err) {
      console.error(`[DEBUG] addUsageFromSeconds hatası:`, err);
      return { over:false, usedDaily: sess?.minutesUsedDaily||0, usedMonthly: sess?.minutesUsedMonthly||0, limits: sess?.limits };
    }
  }

  // Establish connection to Realtime API
  const headers = USE_AZURE
    ? { 'api-key': AZURE_OPENAI_API_KEY }
    : { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const protocols = ['realtime'];
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, protocols, { headers });

  openaiWs.on('open', () => {
    console.log(`[proxy] Connection to ${USE_AZURE ? 'Azure OpenAI' : 'OpenAI'} established.`);
    // For OpenAI (non-Azure), send initial config as before.
    if (!USE_AZURE) {
      // Configure OpenAI Realtime session using Realtime v1 schema
      const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
      const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
      const voicePref = sess?.prefs?.voice || 'alloy';
      const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
      let scenarioText = '';
      if (sess?.prefs?.scenarioId && scenarios.has(sess.prefs.scenarioId)) {
        const sc = scenarios.get(sess.prefs.scenarioId);
        const crit = Array.isArray(sc.successCriteria) ? sc.successCriteria.join('; ') : '';
        scenarioText = `Bağlam: ${sc.title}. Rol: ${sc.personaPrompt}. Başarı ölçütleri: ${crit}`;
      }
          const persona = buildPersonaInstruction(lang, nlang, corr, scenarioText, sess.userLevel) + `\n\nKurallar:\n- Cümleyi tamamlamadan asla durma.\n- Kullanıcı susarsa kısa bir beklemeden sonra cümleyi bitir.\n- Gereksiz yere konuyu değiştirme; soruya doğrudan cevap ver.\n- Soru cümleleri '?' ile bitmeli; cümleler nokta ile tamamlanmalı.\n- Uzun yanıt verirken tek nefeste bitiremediysen kısa bir nefes payı bırakıp cümleyi tamamla.`;
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio','text'],
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          voice: voicePref,
          temperature: 0.8,
          // Let Realtime model handle audio directly; no separate ASR model
          max_response_output_tokens: 480,
          turn_detection: {
            type: 'server_vad',
            threshold: 0.25,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
            create_response: true,
            interrupt_response: true,
          },
          instructions: persona + "\n\nKURAL: Cevap dili SADECE Türkçe. İngilizce ya da başka dil kullanma. Cümleyi nokta veya soru işaretiyle bitir."
        },
      };
      openaiWs.send(JSON.stringify(sessionUpdate));
      // Ek güvence: konuşma başında persona ve dil politikasını sistem mesajı olarak ekle
      try {
        // Persona'yı (senaryo vs.) sistem mesajı olarak ekle + Türkçe-only kuralını güçlendir
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: persona + "\n\nKURAL: Sadece Türkçe cevap ver. Başka dil kullanma." }]
          }
        }));
      } catch {}
      console.log('[proxy] Sent session.update to OpenAI.');
      // Persona is already set in session.instructions; avoid extra system item to reduce tokens
      console.log('[proxy] Session instructions set for OpenAI.');
    } else {
      // Azure: declare audio formats explicitly as strings to ensure PCM16 output (avoid schema error)
      const lang = (sess?.prefs?.language || 'tr').toLowerCase();
      const voicePref = sess?.prefs?.voice || 'alloy';
      const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
      const persona = buildPersonaInstruction(lang, corr, '', sess.userLevel);
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.25,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
            create_response: true,
            interrupt_response: true,
          },
          input_audio_transcription: { language: lang },
          instructions: persona,
          temperature: 0.8,
          max_response_output_tokens: 480,
        },
      };
      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('[proxy] Sent session.update to Azure.');

      // Persona is already set in session.instructions; avoid extra system item to reduce tokens
      console.log('[proxy] Session instructions set for Azure.');
      // Remove auto hello to avoid off-topic bias; responses are triggered on commit
    }
  });

  // Forward messages from Client -> Realtime API using expected JSON framing
  let hasAppendedAudio = false;
  let appendedBytes = 0; // bytes appended since last commit; 100ms @24kHz pcm16 mono ~= 4800 bytes
  let inactivityTimer = null;
  let isResponding = false; // prevent overlapping bot responses
  let pendingResponseTimer = null; // delay timer for response.create after audio_stop
  let suppressUntilTs = 0; // time until which we shouldn't send a response (e.g., 1s after user starts)
  let lastResponseId = null;
  let lastAudioBytes = 0;
  let streamMode = null; // 'buffer' | 'delta'
  // We configure the model with turn_detection.create_response=true,
  // so DO NOT send our own response.create after commit to avoid duplicates.
  const AUTO_CREATE_RESPONSE = true;
  const scheduleAutoCommit = () => {
    if (STRICT_REALTIME) return; // disabled in strict mode
    if (!USE_AZURE) return; // only needed for Azure path
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      try {
        if (hasAppendedAudio && appendedBytes >= 4800 && !isResponding && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          console.log('[proxy] auto-commit after inactivity');
          hasAppendedAudio = false;
          appendedBytes = 0;
          if (!AUTO_CREATE_RESPONSE) {
            const create = {
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: 'Lütfen sadece Türkçe, kısaltma ve doğal yanıt ver.',
              },
            };
            openaiWs.send(JSON.stringify(create));
            console.log('[proxy] sent response.create (auto)');
            isResponding = true;
          }
        }
      } catch (e) {
        console.error('[proxy] auto-commit error:', e);
      }
    }, 1500);
  };
  clientWs.on('message', (data, isBinary) => {
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    try {
      if (isBinary) {
        // While bot is responding, drop any mic frames to avoid echo/feedback loops
        if (isResponding) {
          // Still touch hasAppendedAudio=false to avoid unintended auto commits
          hasAppendedAudio = false;
          appendedBytes = 0;
          return;
        }
        // If a delayed response is pending, cancel it because user started speaking again
        if (pendingResponseTimer) { try { clearTimeout(pendingResponseTimer); } catch {} pendingResponseTimer = null; }

        // If bot is currently responding, cancel the active response
        if (isResponding) {
          try {
            const cancel = { type: 'response.cancel' };
            openaiWs.send(JSON.stringify(cancel));
            console.log('[proxy] cancelled active response due to user interruption');
            isResponding = false;
          } catch (e) {
            console.error('[proxy] failed to cancel response:', e);
          }
        }

        // Reset suppression since user started speaking again
        suppressUntilTs = 0;

        // Convert PCM bytes to base64 and send as input_audio_buffer.append
        const b64 = Buffer.from(data).toString('base64');
        const msg = {
          type: 'input_audio_buffer.append',
          audio: b64,
        };
        openaiWs.send(JSON.stringify(msg));
        hasAppendedAudio = true;
        appendedBytes += Buffer.byteLength(data);
        console.log(`[proxy] forwarded audio chunk ${Buffer.byteLength(data)}B -> append`);
        scheduleAutoCommit();
        return;
      }

      // Handle control messages from client
      const text = data.toString();
      let obj;
      try { obj = JSON.parse(text); } catch { return; }
      const t = obj?.type;
      if (t === 'audio_start') {
        // Optionally could send a session/update here for formats; skip for simplicity
        hasAppendedAudio = false;
        appendedBytes = 0;
        console.log('[DEBUG] client -> audio_start - sess bilgisi:', sess ? JSON.stringify(sess, null, 2) : 'sess yok!');
        speechStartTs = Date.now();
        // Suppress bot response generation for 1s after user starts speaking
        suppressUntilTs = Date.now() + 1000;
        // Start realtime tracking on first audio_start
        if (!realtimeTimer) {
          realtimeStartedAt = Date.now();
          console.log(`[DEBUG] realtimeTimer başlatılıyor, realtimeStartedAt: ${realtimeStartedAt}, sess:`, sess ? JSON.stringify(sess, null, 2) : 'yok');
          realtimeTimer = setInterval(() => {
            try {
              console.log(`[DEBUG] realtimeTimer tick! sess.minutesUsedDaily: ${sess?.minutesUsedDaily}, sess.minutesUsedMonthly: ${sess?.minutesUsedMonthly}`);
              const usage = addUsageFromSeconds(1);
              // Notify client in real time
              clientWs.send(JSON.stringify({ type: 'usage_update', usage: { usedDaily: usage.usedDaily, usedMonthly: usage.usedMonthly, limits: usage.limits } }));
              if (usage.over) {
                // Stop further counting if limit reached
                clearInterval(realtimeTimer);
                realtimeTimer = null;
                clientWs.send(JSON.stringify({ type: 'limit_reached', usage: { usedDaily: usage.usedDaily, usedMonthly: usage.usedMonthly, limits: usage.limits } }));
              }
            } catch (e) {
              console.error('[proxy] realtime usage tick error:', e);
            }
          }, 1000);
        }
        return;
      }
      if (t === 'client_debug') {
        // Surface client debug to logs (optional: could forward to admin channel)
        try { console.log('[client_debug]', obj.event, JSON.stringify(obj)); } catch {}
        return;
      }
      if (t === 'session.update' && obj?.session && typeof obj.session === 'object') {
        // Forward session updates (e.g., voice changes) to OpenAI
        try {
          openaiWs.send(JSON.stringify({ type: 'session.update', session: obj.session }));
          console.log('[proxy] forwarded session.update', JSON.stringify(obj.session));
        } catch (e) {
          console.error('[proxy] error forwarding session.update:', e);
        }
        return;
      }
      if (t === 'set_prefs' && obj?.prefs) {
        try {
          const p = obj.prefs || {};
          // Update in-memory prefs
          if (sess && sess.prefs) {
            if (typeof p.learnLang === 'string') sess.prefs.learnLang = String(p.learnLang).toLowerCase();
            if (typeof p.nativeLang === 'string') sess.prefs.nativeLang = String(p.nativeLang).toLowerCase();
            if (typeof p.voice === 'string') sess.prefs.voice = String(p.voice);
            if (typeof p.correction === 'string') sess.prefs.correction = String(p.correction).toLowerCase();
            if (typeof p.scenarioId === 'string') sess.prefs.scenarioId = p.scenarioId || null;
          }
          const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
          const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
          const voicePref = sess?.prefs?.voice || 'alloy';
          const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
          let scenarioText = '';
          if (sess?.prefs?.scenarioId && scenarios.has(sess.prefs.scenarioId)) {
            const sc = scenarios.get(sess.prefs.scenarioId);
            const crit = Array.isArray(sc.successCriteria) ? sc.successCriteria.join('; ') : '';
            scenarioText = `Bağlam: ${sc.title}. Rol: ${sc.personaPrompt}. Başarı ölçütleri: ${crit}`;
          }
          const persona = buildPersonaInstruction(lang, nlang, corr, scenarioText, sess.userLevel) + "\n\nKURAL: Sadece Türkçe cevap ver. Başka dil kullanma.";
          // Push updated session settings (voice/language hints) and a fresh system message
          openaiWs.send(JSON.stringify({ type: 'session.update', session: { voice: voicePref, instructions: persona, temperature: 0.8, max_response_output_tokens: 480 } }));
          // Persona'yı güçlü uygulamak için sistem mesajı olarak ekle (ayrıca tekil langNotice kaldırıldı)
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: persona }]
            }
          }));
          console.log('[proxy] updated prefs via set_prefs');
        } catch (e) {
          console.error('[proxy] set_prefs error:', e);
        }
        return;
      }
      if (t === 'stop' || t === 'audio_stop') {
        // If this is a manual stop, always process it regardless of audio state
        if (t === 'stop') {
          console.log('[proxy] Received manual stop request');
          // Force update usage when manual stop is received
          if (speechStartTs) {
            const seconds = Math.max(0, (Date.now() - speechStartTs) / 1000);
            const usage = addUsageFromSeconds(seconds);
            // Send updated usage to client
            clientWs.send(JSON.stringify({ 
              type: 'usage_update', 
              usage: { 
                usedDaily: usage.usedDaily, 
                usedMonthly: usage.usedMonthly, 
                limits: usage.limits 
              } 
            }));
            speechStartTs = null;
          }
          // Clean up and close the connection
          cleanup();
          return;
        } else if (!hasAppendedAudio || appendedBytes < 4800) {
          // For audio_stop, only commit if we have sufficient audio
          console.log('[proxy] audio_stop ignored (insufficient audio)');
          return;
        }
        // Commit and request a response when user stops talking
        const commit = { type: 'input_audio_buffer.commit' };
        openaiWs.send(JSON.stringify(commit));
        console.log('[proxy] sent input_audio_buffer.commit');

        // Clear suppression since user finished speaking
        suppressUntilTs = 0;
        if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
        // Update usage based on precise turn duration if realtime timer is NOT active
        let usage = { usedDaily: sess?.minutesUsedDaily, usedMonthly: sess?.minutesUsedMonthly, limits: sess?.limits, over: false };
        if (!realtimeTimer) {
          const seconds = speechStartTs ? Math.max(0, (Date.now() - speechStartTs) / 1000) : (appendedBytes / 48000);
          usage = addUsageFromSeconds(seconds);
          speechStartTs = null;
        }
        // Inform client about updated usage
        clientWs.send(JSON.stringify({ type: 'usage_update', usage: { usedDaily: usage.usedDaily, usedMonthly: usage.usedMonthly, limits: usage.limits } }));
        if (usage.over) {
          // Notify client limit reached and do not generate response
          clientWs.send(JSON.stringify({ type: 'limit_reached', usage: { usedDaily: usage.usedDaily, usedMonthly: usage.usedMonthly, limits: usage.limits } }));
          hasAppendedAudio = false; appendedBytes = 0;
          return;
        }
        // Rely on model auto-response creation; do not send our own response.create
        if (!AUTO_CREATE_RESPONSE) {
          // Build response.create payload
          const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
          const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
          const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
          const persona = buildPersonaInstruction(lang, nlang, corr, '', sess.userLevel);
          const create = {
            type: 'response.create',
            response: {
              modalities: ['audio','text'],
              max_output_tokens: 200,
            }
          };
          // Delay sending response by 1s to allow user to continue; cancel if new audio arrives
          if (pendingResponseTimer) { try { clearTimeout(pendingResponseTimer); } catch {} pendingResponseTimer = null; }
          pendingResponseTimer = setTimeout(() => {
            try {
              if (Date.now() < suppressUntilTs) {
                console.log('[proxy] response.create skipped due to suppress window');
                suppressUntilTs = 0;
                return;
              }
              if (STRICT_REALTIME || !isResponding) {
                openaiWs.send(JSON.stringify(create));
                console.log('[proxy] sent response.create (delayed 1s)');
                if (!STRICT_REALTIME) isResponding = true;
              } else {
                console.log('[proxy] response.create suppressed (already responding)');
              }
            } catch (e) {
              console.error('[proxy] delayed response.create error:', e);
            } finally {
              pendingResponseTimer = null;
            }
          }, 1000);
        }
        hasAppendedAudio = false; // reset for next turn
        appendedBytes = 0;
        return;
      }
      if (t === 'text' && obj?.text) {
        // Proper Realtime text flow: add a user message, then ask for a response
        const userText = String(obj.text || '');
        try {
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: userText }]
            }
          }));
        } catch (e) { console.error('[proxy] failed to append user text item:', e); }

        const create = {
          type: 'response.create',
          response: {
            modalities: ['audio','text'],
            temperature: 0.8,
            max_output_tokens: 160,
          }
        };
        if (STRICT_REALTIME || !isResponding) {
          try { clientWs.send(JSON.stringify({ type: 'debug', src: 'server', event: 'response.create(for user text)', len: userText.length })); } catch {}
          openaiWs.send(JSON.stringify(create));
          console.log('[proxy] sent response.create (for user text)');
          if (!STRICT_REALTIME) isResponding = true;
        } else {
          console.log('[proxy] response.create (text) suppressed (already responding)');
        }
        return;
      }
      // Unknown types are ignored
    } catch (e) {
      console.error('[proxy] Error forwarding client message:', e);
    }
  });

  // Forward messages from Realtime API -> Client
  openaiWs.on('message', (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;

    if (!USE_AZURE) {
      if (isBinary) {
        // Direct binary audio passthrough
        clientWs.send(data, { binary: true });
        return;
      }
      // Decode JSON events from OpenAI and translate audio/text for the web client
      let obj;
      try { obj = JSON.parse(data.toString()); } catch { return; }
      const t = obj?.type;
      if (!t) return;
      // Track audio stream mode to avoid duplicates (buffer vs delta)
      if (typeof openaiWs._audioStreamMode === 'undefined') {
        openaiWs._audioStreamMode = null;
      }
      switch (t) {
        case 'response.created': {
          if (!STRICT_REALTIME) isResponding = true;
          try { clientWs.send(JSON.stringify({ type: 'bot_speaking' })); } catch {}
          if (pendingResponseTimer) { try { clearTimeout(pendingResponseTimer); } catch {} pendingResponseTimer = null; }
          // Reset stream mode at start of response
          openaiWs._audioStreamMode = null;
          break;
        }
        case 'output_audio_buffer.append': {
          // Mark start of bot speaking on first audio chunk (buffer mode)
          if (openaiWs._audioStreamMode === null) {
            openaiWs._audioStreamMode = 'buffer';
            try { clientWs.send(JSON.stringify({ type: 'bot_speaking' })); } catch {}
          }
          const b64 = obj?.audio;
          if (typeof b64 === 'string' && b64.length > 0) {
            const pcm = Buffer.from(b64, 'base64');
            console.log(`[proxy] OpenAI buffer.append ${pcm.byteLength}B`);
            try { clientWs.send(JSON.stringify({ type: 'debug', src: 'openai', event: 'buffer.append', bytes: pcm.byteLength })); } catch {}
            clientWs.send(pcm, { binary: true });
          }
          break;
        }
        case 'output_audio_buffer.commit': {
          // OpenAI may commit multiple times per response; do NOT end playback yet to avoid mid-word cuts.
          // We'll signal audio_end on 'response.output_audio.done' instead.
          console.log('[proxy] OpenAI buffer.commit');
          try { clientWs.send(JSON.stringify({ type: 'debug', src: 'openai', event: 'buffer.commit' })); } catch {}
          break;
        }
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
          // Base64 delta field (delta mode)
          if (openaiWs._audioStreamMode === null) {
            openaiWs._audioStreamMode = 'delta';
            try { clientWs.send(JSON.stringify({ type: 'bot_speaking' })); } catch {}
          }
          const b64 = obj?.delta;
          if (typeof b64 === 'string' && b64.length > 0) {
            const pcm = Buffer.from(b64, 'base64');
            console.log(`[proxy] OpenAI audio.delta ${pcm.byteLength}B`);
            try { clientWs.send(JSON.stringify({ type: 'debug', src: 'openai', event: 'audio.delta', bytes: pcm.byteLength })); } catch {}
            clientWs.send(pcm, { binary: true });
          }
          break;
        }
        case 'response.output_audio.done':
        case 'response.audio.done': {
          // Do NOT immediately signal end to client. Wait until transcript.done passes finish checks.
          try { clientWs.send(JSON.stringify({ type: 'debug', src: 'openai', event: 'audio.done' })); } catch {}
          // Reset stream mode for next response
          openaiWs._audioStreamMode = null;
          // Allow next turn on client side; audio is finished
          if (!STRICT_REALTIME) isResponding = false;
          // Arm pending audio_end
          openaiWs._waitingAudioEnd = true;
          if (openaiWs._audioEndTimer) { try { clearTimeout(openaiWs._audioEndTimer); } catch {} }
          // Fallback: if transcript.done never arrives, flush after 6000ms (uzun yanıtlarda son paketleri kaçırmamak için)
          openaiWs._audioEndTimer = setTimeout(() => {
            try {
              if (openaiWs._waitingAudioEnd && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'audio_end' }));
              }
            } catch {}
            if (!STRICT_REALTIME) isResponding = false;
            openaiWs._waitingAudioEnd = false;
            openaiWs._audioEndTimer = null;
          }, 6000);
          break;
        }
        case 'response.audio_transcript.done': {
          const tr = String(obj?.transcript || '');
          try { clientWs.send(JSON.stringify({ type: 'transcript', text: tr, final: true })); } catch {}
          
          // Daha esnek kontroller - kısa yanıtları da kabul et
          const quoteCount = (tr.match(/"/g) || []).length;
          const openQuote = (quoteCount % 2) === 1;
          const badPunct = /[:;,]\s*$/.test(tr);
          const trailingConnectorTR = /(diye|ve|ama|fakat|çünkü|yani|ki|gibi|de|da)\s*$/i.test(tr);
          const missingTerminal = !/[.!?]["'""]?\s*$/.test(tr);
          const unfinished = /(What do you|How do you|Can you|Could you|Would you|Let's|Let's|Şöyle de diyebilirsin)[:\s]*$/i.test(tr);
          
          // Kısa yanıtları da takip et
          const wordCount = tr.trim().split(/\s+/).length;
          const isShortResponse = wordCount <= 6;

          // Soru cümleleri için daha toleranslı ol (soru işaretiyle bitiyorsa veya soru kelimeleriyle başlıyorsa)
          const isQuestion = /[?]/.test(tr) || /^(What|How|Can|Could|Would|Do you|Are you|Is it|Will you|Can we|Ne|Nasıl|Neden|Kaç|Kim|Nerede|Hangisi)/i.test(tr);
          const isCompleteShortResponse = isShortResponse && (isQuestion || /[.!?]["'""]?\s*$/.test(tr));

          // Eksik bitmiş gibi görünen yanıtlar için follow-up iste (kısa olsa bile)
          const needsExample = (!isCompleteShortResponse) && (badPunct || openQuote || unfinished || trailingConnectorTR || (/Şöyle bir cümle/i.test(tr)) || missingTerminal);
          
          if (needsExample) {
            try {
              // This turn is not fully finished; cancel any pending audio_end from previous segment
              if (openaiWs._audioEndTimer) { try { clearTimeout(openaiWs._audioEndTimer); } catch {} openaiWs._audioEndTimer = null; }
              openaiWs._waitingAudioEnd = true;
              const followup = {
                type: 'response.create',
                response: {
                  modalities: ['audio','text'],
                  max_output_tokens: 140,
                  instructions: 'Yanıtı TAMAMLA ve BİTİR. Son cümleyi tam ve doğal biçimde bitir; gerekiyorsa soru işareti veya nokta koy. Eğer örnek gerekiyorsa sadece tek bir örnek ekle ve şu kalıpla ver: Şöyle de diyebilirsin: "…". Örnek en az 5 kelime olsun ve nokta ile bitsin. Başka hiçbir şey söyleme.'
                }
              };
              openaiWs.send(JSON.stringify(followup));
              console.log('[proxy] follow-up example requested');
            } catch {}
          } else {
            // Safe to end this turn for the client
            if (openaiWs._audioEndTimer) { try { clearTimeout(openaiWs._audioEndTimer); } catch {} openaiWs._audioEndTimer = null; }
            if (openaiWs._waitingAudioEnd) {
              try { clientWs.send(JSON.stringify({ type: 'audio_end' })); } catch {}
            }
            if (!STRICT_REALTIME) isResponding = false;
            openaiWs._waitingAudioEnd = false;
          }
          break;
        }
        case 'response.delta':
        case 'response.transcript.delta':
        case 'response.text.delta':
        case 'response.output_text.delta':
        case 'response.audio_transcript.delta': {
          const text = obj?.delta ?? obj?.text ?? '';
          if (text) clientWs.send(JSON.stringify({ type: 'transcript', text: String(text), final: false }));
          break;
        }
        case 'response.done':
        case 'response.output_text.done':
        case 'response.text.completed':
        case 'response.output_item.done': {
          const text = obj?.text ?? obj?.output_text ?? '';
          if (text) {
            const payload = { type: 'transcript', text: String(text), final: true };
            clientWs.send(JSON.stringify(payload));
          }
          // Ensure client resumes mic even for text-only completions
          if (!STRICT_REALTIME) isResponding = false;
          try {
            // Eğer bu turda audio akışı olduysa ve audio_end bekleniyorsa burada bitiş sinyali göndermeyelim.
            if (!openaiWs._waitingAudioEnd) {
              clientWs.send(JSON.stringify({ type: 'audio_end' }));
            }
          } catch {}
          openaiWs._audioStreamMode = null;
          break;
        }
        case 'error': {
          // Ignore benign empty-commit errors to reduce noise on client
          const code = obj?.error?.code || obj?.code;
          if (code === 'input_audio_buffer_commit_empty') {
            console.warn('[proxy] ignored error:', code);
            break;
          }
          clientWs.send(JSON.stringify({ type: 'error', error: obj?.error || obj }));
          break;
        }
        default: {
          // Forward other events for debugging
          clientWs.send(JSON.stringify(obj));
          break;
        }
      }
      return;
    }

    // Azure: decode JSON events and translate
    if (isBinary) {
      // Azure typically does not send raw binary; ignore defensively
      return;
    }

    let obj;
    try {
      obj = JSON.parse(data.toString());
    } catch { return; }
    const t = obj?.type;
    if (t) console.log(`[proxy] Azure -> ${t}`);
    // Track which audio streaming variant Azure uses per response to avoid duplicates
    // Values: null | 'buffer' | 'delta'
    if (typeof openaiWs._audioStreamMode === 'undefined') {
      openaiWs._audioStreamMode = null;
    }
    switch (t) {
      case 'output_audio_buffer.append': {
        // Prefer buffer mode; if first audio seen in this response, lock to 'buffer'
        if (openaiWs._audioStreamMode === null) openaiWs._audioStreamMode = 'buffer';
        if (openaiWs._audioStreamMode !== 'buffer') break;
        // Base64 audio chunk -> forward as binary to client player
        const b64 = obj?.audio;
        if (typeof b64 === 'string' && b64.length > 0) {
          const pcm = Buffer.from(b64, 'base64');
          clientWs.send(pcm, { binary: true });
        }
        break;
      }
      case 'output_audio_buffer.commit': {
        // Signal end of current audio buffer
        clientWs.send(JSON.stringify({ type: 'audio_end' }));
        // Reset stream mode for next response
        openaiWs._audioStreamMode = null;
        break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta':
      case 'output_audio.delta': {
        // If buffer mode already active, ignore deltas to avoid duplication
        if (openaiWs._audioStreamMode === 'buffer') break;
        if (openaiWs._audioStreamMode === null) openaiWs._audioStreamMode = 'delta';
        const b64 = obj?.delta;
        if (typeof b64 === 'string' && b64.length > 0) {
          const pcm = Buffer.from(b64, 'base64');
          clientWs.send(pcm, { binary: true });
        }
        break;
      }
      case 'response.delta':
      case 'response.transcript.delta':
      case 'response.text.delta':
      case 'response.output_text.delta': {
        const text = obj?.delta ?? obj?.text ?? '';
        if (text) {
          const payload = { type: 'transcript', text: String(text), final: false };
          clientWs.send(JSON.stringify(payload));
        }
        break;
      }
      case 'response.created': {
        if (!STRICT_REALTIME) isResponding = true;
        // Notify client to pause mic immediately to avoid overlap
        clientWs.send(JSON.stringify({ type: 'bot_speaking' }));
        // Cancel any pending delayed create since model already started
        if (pendingResponseTimer) { try { clearTimeout(pendingResponseTimer); } catch {} pendingResponseTimer = null; }
        // Reset stream mode at start of response
        openaiWs._audioStreamMode = null;
        break;
      }
      case 'response.audio.done': {
        // Fallback: mark end of audio
        clientWs.send(JSON.stringify({ type: 'audio_end' }));
        openaiWs._audioStreamMode = null;
        break;
      }
      case 'response.output_item.done':
      case 'response.done':
      case 'response.completed':
      case 'response.final':
      case 'response.text.completed':
      case 'response.output_text.done': {
        const text = obj?.text ?? obj?.output_text ?? obj?.final_text ?? '';
        if (text) {
          const payload = { type: 'transcript', text: String(text), final: true };
          clientWs.send(JSON.stringify(payload));
        }
        if (!STRICT_REALTIME) isResponding = false; // allow next turn
        // Ensure client resumes mic
        clientWs.send(JSON.stringify({ type: 'audio_end' }));
        openaiWs._audioStreamMode = null;

        // Reset audio buffer state for next conversation turn
        hasAppendedAudio = false;
        appendedBytes = 0;
        suppressUntilTs = 0;

        // Re-apply session instructions for next turn (ensure consistency)
        try {
          const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
          const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
          const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
          const persona = buildPersonaInstruction(lang, nlang, corr, '', sess.userLevel);
          const sessionUpdate = {
            type: 'session.update',
            session: {
              instructions: persona,
              max_response_output_tokens: 480,
              voice: sess?.prefs?.voice || 'alloy',
              temperature: 0.8,
            }
          };
          openaiWs.send(JSON.stringify(sessionUpdate));
          console.log('[proxy] Re-applied session instructions after response completion');
        } catch (e) {
          console.error('[proxy] Failed to re-apply session instructions:', e);
        }
      }
      case 'error': {
        console.error('[proxy] Azure error payload:', JSON.stringify(obj));
        clientWs.send(JSON.stringify({ type: 'error', error: obj?.error ?? 'unknown' }));
        break;
      }
      default: {
        // Forward unknown events verbatim for debugging
        clientWs.send(JSON.stringify(obj));
        break;
      }
    }
  });

  // Handle connection closing
  const cleanup = () => {
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close();
    }
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (realtimeTimer) { try { clearInterval(realtimeTimer); } catch {} realtimeTimer = null; }
    // If user was mid-speech when closing, account remaining segment (only if realtime not running)
    try {
      if (speechStartTs && !realtimeTimer) {
        const seconds = Math.max(0, (Date.now() - speechStartTs) / 1000);
        addUsageFromSeconds(seconds);
        speechStartTs = null;
      }
    } catch (e) {
      console.error('[proxy] cleanup usage flush error:', e);
    }
    console.log('[proxy] Connections closed.');
  };

  clientWs.on('close', () => {
    console.log('[server] Client disconnected.');
    // Ensure we save any remaining usage before cleaning up
    if (sess && sess.usage) {
      const usage = sess.usage;
      if (usage.startTime) {
        const endTime = new Date();
        const seconds = Math.ceil((endTime - new Date(usage.startTime)) / 1000);
        if (seconds > 0) {
          addUsageFromSeconds(seconds);
        }
      }
    }
    cleanup();
  });

  openaiWs.on('close', (code, reason) => {
    console.log(`[proxy] Connection to OpenAI closed: ${code} ${reason.toString()}`);
    cleanup();
  });

  // Handle errors
  clientWs.on('error', (error) => {
    console.error('[server] Client WebSocket error:', error);
    cleanup();
  });

  openaiWs.on('error', (error) => {
    console.error('[proxy] OpenAI WebSocket error:', error);
    cleanup();
  });
});

// Connect to MongoDB then start server
mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log('[mongo] connected');
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Sunucu ${PORT} portunda çalışıyor`);
      console.log(`Ortam: ${process.env.NODE_ENV || 'development'}`);
      console.log(`MongoDB: ${MONGODB_URI}`);
      console.log(`Tarih: ${new Date().toISOString()}`);
    });
  })
  .catch((err) => {
    console.error('[mongo] connection error:', err?.message || err);
    // Still start the server to serve static pages, but auth/features will fail until DB is up
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Sunucu ${PORT} portunda çalışıyor (MongoDB bağlantısı yok)`);
    });
  });


