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
import { User, Subscription, Usage, Streak, Achievement, Goal } from './models.js';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import Iyzipay from 'iyzipay';
import crypto from 'crypto';
import { Resend } from 'resend';
import fs from 'fs';

const app = express();
const server = createServer(app);
// Trust proxy headers (Render/Heroku/Nginx vb.) so rate-limit and req.ip work correctly
// This fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from express-rate-limit
app.set('trust proxy', 1);
// Remove X-Powered-By header
app.disable('x-powered-by');

// Env
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const STRICT_REALTIME = String(process.env.STRICT_REALTIME || 'false').toLowerCase() === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hemekonus';
const IYZICO_API_KEY = process.env.IYZICO_API_KEY || '';
const IYZICO_SECRET_KEY = process.env.IYZICO_SECRET_KEY || '';
const IYZICO_BASE_URL = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';
const PAYTR_MERCHANT_ID = process.env.PAYTR_MERCHANT_ID || '';
const PAYTR_MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY || '';
const PAYTR_MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@konuskonuşabilirsen.com';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
// Admins (comma-separated emails)
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

// Persona builder for brand-specific language coach behavior
function buildPersonaInstruction(learnLang = 'tr', nativeLang = 'tr', correction = 'gentle', scenarioText = ''){
  const l = String(learnLang || 'tr').toLowerCase();
  const n = String(nativeLang || 'tr').toLowerCase();
  const c = String(correction || 'gentle').toLowerCase();
  const learnName = l === 'tr' ? 'Türkçe' : (l === 'en' ? 'İngilizce' : l);
  const nativeName = n === 'tr' ? 'Türkçe' : (n === 'en' ? 'İngilizce' : n);
  const fixStyle = (
    c === 'off' ? 'Düzeltme yapma; sadece anlayıp doğal ve kısa yanıt ver.' :
    c === 'strict' ? 'Dil hatalarını tespit et ve nazik ama net şekilde düzelt. Önce kısa yanıt ver, ardından bir cümle içinde düzeltmeyi açıkla ve bir örnek ver. Örnek formatı: “Şöyle de diyebilirsin: …”.' :
    'Gerekirse hataları nazikçe düzelt. Kısa yanıt ver; en fazla bir cümlelik açıklama ve küçük bir örnek ekle. Örnek formatı: “Şöyle de diyebilirsin: …”.'
  );
  const safety = 'Konudan sapma; sadece kullanıcının söylediğine yanıt ver. Anlamazsan kibarca tekrar iste.';
  const tone = 'Sıcak, motive edici ve saygılı bir dil koçu gibi konuş.';
  const convo = 'Her turda: 1 kısa doğal yanıt + kullanıcıyı konuşturan tek bir kısa soru.';
  // Dil politikası: daima hedef dilde; ana dil sadece gerekirse 1 çok kısa ipucu için
  const langPolicy = `YANIT DİLİ: Daima ${learnName}. ${nativeName} en fazla tek cümlelik çok kısa ipucu için (gerekirse). Başka dillere kayma.`;
  // Sesli çıktı için sade biçim
  const format = `BİÇİM: (1) ${learnName} dilinde 1-2 kısa öneri söyle. (2) Gerekirse ${nativeName} dilinde 1 cümlelik çok kısa ipucu ekle ("Tip:" ile başlat). (3) Mümkünse tek basit dilbilgisi noktası vurgula.`;
  const lengthPolicy = 'UZUNLUK: Varsayılan 1-2 cümle. Kullanıcı açıkça daha detay isterse 3-4 cümleye çık.';
  const gentleLimits = 'Gentle modda: Anlam bozulmuyorsa düzeltme yapma. Düzeltirsen: hatayı çok kısa belirt + ana dilde 1 cümlelik ipucu + hedef dilde tek örnek.';
  const scenarioPart = scenarioText ? ` Senaryo bağlamı: ${scenarioText}` : '';
  const pacing = 'Konuşma hızını biraz yavaş tut. 1-2 kısa cümleyle konuş. Kullanıcıyı konuşturan kısa sorular sor.';
  return `Markaya özel dil koçu asistan (“hemenkonus”). Kullanıcının ana dili: ${nativeName}. Öğrenilen dil: ${learnName}. ${tone} ${convo} ${langPolicy} ${lengthPolicy} ${format} ${fixStyle} ${gentleLimits} ${safety} ${pacing}${scenarioPart}`;
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
app.use(express.json({ limit: '1mb' }));
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
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:"] ,
      "connect-src": ["'self'", "https://api.openai.com", "wss:", "ws:"]
    }
  },
  crossOriginEmbedderPolicy: false,
}));

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

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests without Origin (same-origin or curl)
    if (!origin) return callback(null, true);
    // Always allow local development origins
    const localOk = /^(http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+)$/.test(origin);
    if (localOk) return callback(null, true);
    if (allowedOriginsSet.size === 0) return callback(null, true);
    if (allowedOriginsSet.has(origin)) return callback(null, true);
    try {
      const u = new URL(origin);
      const asciiHost = toASCII(u.hostname);
      const normalized = `${u.protocol}//${asciiHost}${u.port ? ':'+u.port : ''}`;
      if (allowedOriginsSet.has(normalized)) return callback(null, true);
    } catch {}
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

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
    const { limit = 50 } = req.query || {};
    const lmt = Math.max(1, Math.min(500, Number(limit) || 50));
    const docs = await Analytics.find({}).sort({ ts: -1 }).limit(lmt).lean();
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
    const { from, to, limit = 10 } = req.query || {};
    const lmt = Math.max(1, Math.min(100, Number(limit) || 10));
    const match = {};
    if (from || to){
      match.ts = {};
      if (from) match.ts.$gte = new Date(from + 'T00:00:00Z');
      if (to) match.ts.$lte = new Date(to + 'T23:59:59Z');
    }
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
    return res.json({ total, byDay, countries, paths, referrers });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
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

// ---- Protected: Current user ----
app.get('/me', authRequired, async (req, res) => {
  try {
    const userDoc = await User.findById(req.auth.uid).lean();
    if (!userDoc) return res.status(404).json({ error: 'not_found' });
    const sub = await Subscription.findOne({ userId: req.auth.uid, status: 'active' }).lean();
    const plan = sub?.plan || 'free';
    return res.json({
      id: String(userDoc._id),
      email: userDoc.email,
      emailVerified: !!userDoc.emailVerified,
      preferredLanguage: userDoc.preferredLanguage || null,
      preferredVoice: userDoc.preferredVoice || null,
      preferredCorrectionMode: userDoc.preferredCorrectionMode || 'gentle',
      preferredLearningLanguage: userDoc.preferredLearningLanguage || 'en',
      preferredNativeLanguage: userDoc.preferredNativeLanguage || 'tr',
      placementLevel: userDoc.placementLevel || null,
      placementCompletedAt: userDoc.placementCompletedAt || null,
      plan,
    });
  } catch (e){
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- Protected: Update preferences ----
app.patch('/me/preferences', authRequired, async (req, res) => {
  try {
    const { preferredLanguage, preferredVoice, preferredCorrectionMode, preferredLearningLanguage, preferredNativeLanguage } = req.body || {};
    const updates = {};
    if (typeof preferredLanguage === 'string') updates.preferredLanguage = preferredLanguage;
    if (typeof preferredVoice === 'string') updates.preferredVoice = preferredVoice;
    if (typeof preferredCorrectionMode === 'string') updates.preferredCorrectionMode = preferredCorrectionMode;
    if (typeof preferredLearningLanguage === 'string') updates.preferredLearningLanguage = preferredLearningLanguage;
    if (typeof preferredNativeLanguage === 'string') updates.preferredNativeLanguage = preferredNativeLanguage;
    const userDoc = await User.findByIdAndUpdate(req.auth.uid, { $set: updates }, { new: true });
    if (!userDoc) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true,
      preferredLanguage: userDoc.preferredLanguage || null,
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
// Enable trust proxy for correct req.ip behind proxies
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
    // Choose first public IP from X-Forwarded-For chain
    const xff = (req.headers['x-forwarded-for'] || '').toString();
    const chain = xff.split(',').map(s => s.trim()).filter(Boolean);
    let chosenIp = null;
    for (const cand of chain){ if (!isPrivateIp(cand)) { chosenIp = cand; break; } }
    if (!chosenIp) chosenIp = (req.ip || req.connection?.remoteAddress || '').toString();
    const ip = chosenIp.replace('::ffff:','');
    const ipHash = hashIp(ip);
    let country = (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country'] || null) || null;
    let countrySource = country ? 'header' : null;
    const uid = req.auth?.uid ? new mongoose.Types.ObjectId(req.auth.uid) : null;
    const anonId = getOrSetAnonId(req, res) || null;
    const doc = { path: p, referrer: ref, userAgent: ua, ipHash, ipRaw: ip, country, countrySource, anonId, uid, ts: new Date() };
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

// Contact form submission
app.post('/api/contact', express.json(), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Basic validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Lütfen tüm alanları doldurunuz.' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi giriniz.' });
    }

    // Send email using Resend
    if (resend) {
      await resend.emails.send({
        from: `"${name}" <${MAIL_FROM}>`,
        to: 'info@konuskonusabilirsen.com',
        reply_to: email,
        subject: `İletişim Formu: ${subject}`,
        html: `
          <h2>Yeni İletişim Formu Gönderimi</h2>
          <p><strong>Ad Soyad:</strong> ${name}</p>
          <p><strong>E-posta:</strong> ${email}</p>
          <p><strong>Konu:</strong> ${subject}</p>
          <p><strong>Mesaj:</strong></p>
          <p>${message.replace(/\n/g, '<br>')}</p>
        `,
      });
    } else {
      console.warn('Resend API key not configured. Email would be sent to:', {
        to: 'info@konuskonusabilirsen.com',
        from: `"${name}" <${MAIL_FROM}>`,
        replyTo: email,
        subject: `İletişim Formu: ${subject}`,
        message
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ 
      error: 'Mesajınız gönderilirken bir hata oluştu. Lütfen daha sonra tekrar deneyin.' 
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
    await Subscription.findOneAndUpdate(
      { userId: user._id, plan },
      { $set: { status: 'active', currentPeriodEnd: null } },
      { upsert: true }
    );
    return res.json({ ok: true, userId: String(user._id), email: lower, plan });
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
      // Kullanıcı var ama doğrulanmamış: şifreyi güncelle ve yeniden doğrulama yolla
      existing.passwordHash = await bcrypt.hash(String(password), 10);
      existing.verifyToken = crypto.randomBytes(16).toString('hex');
      existing.verifyExpires = new Date(Date.now() + 24*60*60*1000);
      await existing.save();
      const url = `${req.protocol}://${req.get('host')}/verify.html?token=${existing.verifyToken}`;
      if (resend) {
        console.log(`[resend] sending verify email to ${lower} (existing-unverified)`);
        const { data, error } = await resend.emails.send({ from: MAIL_FROM, to: lower, subject: 'E-posta Doğrulama - KonusKonusabilirsen', html: `<p>Hesabınızı doğrulamak için tıklayın:</p><p><a href="${url}">${url}</a></p>` });
        if (error) { console.error('[resend] register verify email error:', error); }
        else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
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
    if (resend) {
      console.log(`[resend] sending verify email to ${lower} (new-user)`);
      const { data, error } = await resend.emails.send({ from: MAIL_FROM, to: lower, subject: 'E-posta Doğrulama - KonusKonusabilirsen', html: `<p>Hesabınızı doğrulamak için tıklayın:</p><p><a href="${url}">${url}</a></p>` });
      if (error) { console.error('[resend] register verify email error:', error); }
      else { console.log(`[resend] sent id=${data?.id || 'n/a'}`); }
    } else {
      console.log(`[mail] Doğrulama (${lower}): ${url}`);
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
        html: `<p>Şifrenizi sıfırlamak için aşağıdaki bağlantıya tıklayın:</p><p><a href="${url}">${url}</a></p><p>Bu bağlantı 1 saat geçerlidir.</p>`
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
    const priceMap = { starter: 1.00, pro: 299.00, enterprise: 9999.00 };
    const price = priceMap[String(plan)] ?? priceMap.starter;
    const payment_amount = Math.round(price * 100); // kuruş

    const merchant_oid = `hk${uuidv4().replace(/-/g,'')}`;
    const user_ip = getClientIp(req);
    const email = req.auth?.email || 'test@example.com';
    const user_name = 'Hemen Konus';
    const user_address = 'İstanbul';
    const user_phone = '+905555555555';
    const merchant_ok_url = `${req.protocol}://${req.get('host')}/success.html`;
    const merchant_fail_url = `${req.protocol}://${req.get('host')}/cancel.html`;
    const currency = 'TL';
    const test_mode = 1; // sandbox
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
      console.error('[paytr] get-token error:', data);
      return res.status(500).json({ error: 'paytr_error', detail: data.reason || 'unknown' });
    }
    // Track pending for callback (merchant_oid -> { uid, plan })
    iyzPending.set(merchant_oid, { uid: req.auth.uid, plan });
    const token = data.token;
    const iframe_url = `https://www.paytr.com/odeme/guvenli/${token}`;
    return res.json({ token, iframe_url });
  }catch(e){
    console.error('[paytr] checkout error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// PayTR callback
app.post('/paytr/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try{
    const {
      merchant_oid = '', status = '', total_amount = '', hash = ''
    } = req.body || {};
    // Verify hash
    const hash_str = `${merchant_oid}${PAYTR_MERCHANT_SALT}${status}${total_amount}`;
    const calc = crypto.createHmac('sha256', PAYTR_MERCHANT_KEY).update(hash_str, 'utf8').digest('base64');
    if (calc !== hash){
      console.error('[paytr] invalid hash for oid', merchant_oid);
      return res.end('OK'); // must respond OK regardless
    }
    if (status === 'success'){
      const sess = iyzPending.get(merchant_oid);
      if (sess && sess.uid){
        await Subscription.findOneAndUpdate(
          { userId: sess.uid, plan: sess.plan },
          { $set: { status: 'active', currentPeriodEnd: null } },
          { upsert: true }
        );
        // Send email notification (best-effort)
        try{
          const userDoc = await User.findById(sess.uid).lean();
          const email = userDoc?.email || null;
          const amountTl = Number(total_amount) / 100;
          if (email) await sendPaymentSuccessEmail(email, { plan: sess.plan, amountTl, oid: merchant_oid });
        } catch (e){ console.warn('[paytr] email notify error:', e?.message || e); }
      }
      iyzPending.delete(merchant_oid);
    }
    // PayTR expects plain 'OK'
    return res.end('OK');
  }catch(e){
    console.error('[paytr] callback error:', e);
    return res.end('OK');
  }
});

// ---- Iyzico basic checkout (sandbox-friendly) ----
function getIyzico() {
  if (!IYZICO_API_KEY || !IYZICO_SECRET_KEY) return null;
  return new Iyzipay({ apiKey: IYZICO_API_KEY, secretKey: IYZICO_SECRET_KEY, uri: IYZICO_BASE_URL });
}

// Track pending Iyzico checkouts: conversationId -> { uid, plan }
const iyzPending = new Map();

// Create a checkout form for a selected plan. Requires auth.
app.post('/api/iyzico/checkout', authRequired, async (req, res) => {
  try {
    const iyz = getIyzico();
    if (!iyz) return res.status(500).json({ error: 'iyzico_not_configured' });
    const { plan = 'pro' } = req.body || {};
    // Minimal pricing for sandbox (starter: 1 TL test)
    const priceMap = { starter: '1.00', pro: '299.00', enterprise: '9999.00' };
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
        ip: req.ip || '127.0.0.1',
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
    // Determine plan limits
    const sub = await Subscription.findOne({ userId: req.auth.uid, status: 'active' }).lean();
    const plan = sub?.plan || 'free';
    const limitMap = { free: { daily: 5, monthly: 5 }, starter: { daily: 10, monthly: 300 }, pro: { daily: 60, monthly: 1800 } };
    const limits = limitMap[String(plan)] || limitMap.free;
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
        max_response_output_tokens: 30,
        turn_detection: {
          type: 'server_vad',
          // conservative defaults; can be tuned later
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800
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
// session: { plan, createdAt, minutesUsedDaily, minutesUsedMonthly, limits: { daily, monthly }, userId, prefs: { learnLang, nativeLang, voice, correction } }
const sessions = new Map();

// Realtime API endpoint (Azure or OpenAI)
const OPENAI_REALTIME_URL = USE_AZURE
  ? `${AZURE_OPENAI_ENDPOINT.replace(/^http/, 'ws')}/openai/realtime?api-version=${AZURE_OPENAI_API_VERSION}&deployment=${AZURE_OPENAI_DEPLOYMENT}`
  : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;

// Start session
app.post('/session/start', async (req, res) => {
  const { plan = 'free' } = req.body || {};
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
  // minute limits per plan (daily / monthly)
  const limitMap = {
    free: { daily: 5, monthly: 5 },
    starter: { daily: 10, monthly: 300 },
    pro: { daily: 60, monthly: 1800 },
  };
  const limits = limitMap[String(plan)] || limitMap.free;
  // Load user prefs if available
  let prefs = { learnLang: 'tr', nativeLang: 'tr', voice: 'alloy', correction: 'gentle', scenarioId: null };
  try {
    if (uid) {
      const u = await User.findById(uid).lean();
      if (u) {
        if (u.preferredLearningLanguage) prefs.learnLang = String(u.preferredLearningLanguage).toLowerCase();
        if (u.preferredNativeLanguage) prefs.nativeLang = String(u.preferredNativeLanguage).toLowerCase();
        if (u.preferredVoice) prefs.voice = String(u.preferredVoice);
        if (u.preferredCorrectionMode) prefs.correction = String(u.preferredCorrectionMode).toLowerCase();
      }
    }
  } catch {}
  // Initialize usage from DB
  let minutesUsedDaily = 0;
  let minutesUsedMonthly = 0;
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dateBucket = `${y}-${m}-${d}`;
    const monthBucket = `${y}-${m}`;
    const dailyDoc = await Usage.findOne({ userId: uid, dateBucket }).lean();
    const monthAgg = await Usage.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(uid), monthBucket } },
      { $group: { _id: null, minutes: { $sum: '$minutes' } } }
    ]);
    minutesUsedDaily = Number(dailyDoc?.minutes || 0);
    minutesUsedMonthly = Number(monthAgg?.[0]?.minutes || 0);
  } catch (e) {
    console.warn('[session] usage preload error:', e?.message || e);
  }
  // If over limit, block session start
  if (minutesUsedDaily >= limits.daily || minutesUsedMonthly >= limits.monthly) {
    return res.status(403).json({ error: 'limit_reached', message: 'Kullanım limitiniz doldu.', minutesUsedDaily, minutesUsedMonthly, minutesLimitDaily: limits.daily, minutesLimitMonthly: limits.monthly, plan: String(plan) });
  }
  const sessObj = { plan: String(plan), createdAt, minutesUsedDaily, minutesUsedMonthly, limits, userId: uid, prefs };
  sessions.set(sessionId, sessObj);
  return res.json({ sessionId, wsUrl: `/realtime/ws?sessionId=${sessionId}`.replace('http','ws'), plan: String(plan), minutesLimitDaily: limits.daily, minutesLimitMonthly: limits.monthly, minutesUsedDaily, minutesUsedMonthly });
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
    try {
      const minutes = seconds / 60;
      if (!sess || !minutes || minutes <= 0) return { over:false, usedDaily: sess?.minutesUsedDaily||0, usedMonthly: sess?.minutesUsedMonthly||0, limits: sess?.limits };
      sess.minutesUsedDaily = (sess.minutesUsedDaily || 0) + minutes;
      sess.minutesUsedMonthly = (sess.minutesUsedMonthly || 0) + minutes;
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
        Usage.updateOne(
          { userId: new mongoose.Types.ObjectId(sess.userId), dateBucket, monthBucket },
          { $inc: { minutes } },
          { upsert: true }
        ).catch(()=>{});
      } catch {}
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
    } catch {
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
      const persona = buildPersonaInstruction(lang, nlang, corr, scenarioText);
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio'],
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          voice: voicePref,
          temperature: 0.2,
          input_audio_transcription: { language: nlang },
          max_response_output_tokens: 20,
          turn_detection: {
            type: 'server_vad',
            threshold: 0.35,
            prefix_padding_ms: 300,
            silence_duration_ms: 900,
            create_response: false,
            interrupt_response: true,
          },
          instructions: persona
        },
      };
      openaiWs.send(JSON.stringify(sessionUpdate));
      // Ek güvence: konuşma başında dilleri ve politika özetini sistem mesajı olarak ekle
      try {
        const langNotice = `System notice: User native=${nlang}, target=${lang}. Always answer in target language; optionally add one short ${nlang} tip line if needed.`;
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: langNotice }]
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
      const persona = buildPersonaInstruction(lang, corr);
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.3,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: false,
            interrupt_response: true,
          },
          input_audio_transcription: { language: lang },
          instructions: persona,
          temperature: 0.1,
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
  const scheduleAutoCommit = () => {
    if (STRICT_REALTIME) return; // disabled in strict mode
    if (!USE_AZURE) return; // only needed for Azure path
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      try {
        if (hasAppendedAudio && appendedBytes >= 4800 && !isResponding && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          console.log('[proxy] auto-commit after inactivity');
          const create = {
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              // Ensure Turkish output during auto-commit as well
              instructions: 'Lütfen sadece Türkçe, kısaltma ve doğal yanıt ver.',
            },
          };
          openaiWs.send(JSON.stringify(create));
          console.log('[proxy] sent response.create (auto)');
          hasAppendedAudio = false;
          appendedBytes = 0;
          isResponding = true;
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
        console.log('[proxy] client -> audio_start');
        speechStartTs = Date.now();
        // Suppress bot response generation for 1s after user starts speaking
        suppressUntilTs = Date.now() + 1000;
        // Start realtime tracking on first audio_start
        if (!realtimeTimer) {
          realtimeStartedAt = Date.now();
          realtimeTimer = setInterval(() => {
            try {
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
          const persona = buildPersonaInstruction(lang, nlang, corr, scenarioText);
          // Push updated session settings (voice/language hints) and a fresh system message
          openaiWs.send(JSON.stringify({ type: 'session.update', session: { voice: voicePref, input_audio_transcription: { language: nlang }, instructions: persona, temperature: 0.2 } }));
          // Extra system persona item gereksiz; tekrarı kaldırdık
          console.log('[proxy] updated prefs via set_prefs');
        } catch (e) {
          console.error('[proxy] set_prefs error:', e);
        }
        return;
      }
      if (t === 'audio_stop') {
        // Only commit if we actually appended audio; otherwise ignore to avoid empty-commit errors
        if (!hasAppendedAudio || appendedBytes < 4800) {
          console.log('[proxy] audio_stop ignored (insufficient audio)');
          return;
        }
        // Commit and request a response when user stops talking
        const commit = { type: 'input_audio_buffer.commit' };
        openaiWs.send(JSON.stringify(commit));
        console.log('[proxy] sent input_audio_buffer.commit');
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
        // Build response.create payload
        const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
        const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
        const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
        const persona = buildPersonaInstruction(lang, nlang, corr);
        const create = {
          type: 'response.create',
          response: {
            modalities: ['audio'],
            // Per-turn extra instructions kaldırıldı; persona zaten session.instructions içinde
            max_output_tokens: 20,
          }
        };
        if (usage.over) {
          // Notify client limit reached and do not generate response
          clientWs.send(JSON.stringify({ type: 'limit_reached', usage: { usedDaily: usage.usedDaily, usedMonthly: usage.usedMonthly, limits: usage.limits } }));
          hasAppendedAudio = false; appendedBytes = 0;
          return;
        }
        // Delay sending response by 4 seconds to allow user to continue; cancel if new audio arrives
        if (pendingResponseTimer) { try { clearTimeout(pendingResponseTimer); } catch {} pendingResponseTimer = null; }
        pendingResponseTimer = setTimeout(() => {
          try {
            // If suppressed (user just started speaking), skip
            if (Date.now() < suppressUntilTs) { console.log('[proxy] response.create skipped due to suppress window'); return; }
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
        hasAppendedAudio = false; // reset for next turn
        appendedBytes = 0;
        return;
      }
      if (t === 'text' && obj?.text) {
        // Convert text to response.create; OpenAI path must NOT include response.modalities
        const lang = (sess?.prefs?.learnLang || 'tr').toLowerCase();
        const nlang = (sess?.prefs?.nativeLang || 'tr').toLowerCase();
        const corr = (sess?.prefs?.correction || 'gentle').toLowerCase();
        const persona = buildPersonaInstruction(lang, nlang, corr);
        // Detect if user asked for explanation in text prompt to allow longer answer
        const wantsExplain = /\b(açıkla|neden|detay|ayrıntı|örnek ver|teach|explain|why)\b/i.test(String(obj.text || ''));
        const create = {
          type: 'response.create',
          response: {
            modalities: RESPONSE_TEXT_ENABLED ? ['audio','text'] : ['audio'],
            instructions: `Target language: ${lang}. Native: ${nlang}. Asla başka dile kayma. Kullanıcı: ${String(obj.text)}\n1-2 kısaltma öneri ver (hedef dilde), yeni satırda ${nlang} tek cümle 'Tip:' ekle.`,
            max_output_tokens: 30,
          }
        };
        if (STRICT_REALTIME || !isResponding) {
          openaiWs.send(JSON.stringify(create));
          console.log('[proxy] sent response.create (text prompt)');
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
        case 'output_audio_buffer.append': {
          const b64 = obj?.audio;
          if (typeof b64 === 'string' && b64.length > 0) {
            const pcm = Buffer.from(b64, 'base64');
            console.log(`[proxy] OpenAI buffer.append ${pcm.byteLength}B`);
            clientWs.send(pcm, { binary: true });
          }
          break;
        }
        case 'output_audio_buffer.commit': {
          console.log('[proxy] OpenAI buffer.commit');
          clientWs.send(JSON.stringify({ type: 'audio_end' }));
          break;
        }
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
          // Base64 delta field
          const b64 = obj?.delta;
          if (typeof b64 === 'string' && b64.length > 0) {
            const pcm = Buffer.from(b64, 'base64');
            console.log(`[proxy] OpenAI audio.delta ${pcm.byteLength}B`);
            clientWs.send(pcm, { binary: true });
          }
          break;
        }
        case 'response.output_audio.done':
        case 'response.audio.done': {
          clientWs.send(JSON.stringify({ type: 'audio_end' }));
          break;
        }
        case 'response.delta':
        case 'response.transcript.delta':
        case 'response.text.delta':
        case 'response.output_text.delta': {
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
          // Also ensure audio_end for safety
          clientWs.send(JSON.stringify({ type: 'audio_end' }));
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
    } catch (e) {
      console.warn('[proxy] Non-JSON message from Azure, ignoring');
      return;
    }

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
        break;
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
    server.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[mongo] connection error:', err?.message || err);
    // Still start the server to serve static pages, but auth/features will fail until DB is up
    server.listen(PORT, () => {
      console.log(`[server] Listening (without DB) on http://localhost:${PORT}`);
    });
  });
