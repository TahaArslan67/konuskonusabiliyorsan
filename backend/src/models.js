import mongoose from 'mongoose';

const { Schema, model } = mongoose;

  // User schema
  const userSchema = new Schema(
    {
      email: { type: String, required: true, unique: true, index: true },
    googleId: { type: String, default: null, unique: true, sparse: true, index: true },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    preferredLanguage: { type: String, default: null },
    preferredVoice: { type: String, default: null },
    preferredCorrectionMode: { type: String, default: 'gentle' },
    preferredLearningLanguage: { type: String, default: 'en' },
    preferredNativeLanguage: { type: String, default: 'tr' },
    placementLevel: { type: String, default: null },
    placementCompletedAt: { type: Date, default: null },
    verifyToken: { type: String, default: null },
    verifyExpires: { type: Date, default: null },
    resetToken: { type: String, default: null },
    resetExpires: { type: Date, default: null },
        // Plan ve kullanım bilgileri
      plan: { 
        type: String, 
        enum: ['free', 'starter', 'pro'], 
        default: 'free' 
      },
      planUpdatedAt: { type: Date, default: null },
      usage: {
        dailyUsed: { type: Number, default: 0 },
        dailyLimit: { type: Number, default: 3 }, // Ücretsiz kullanım limiti (dakika)
        monthlyUsed: { type: Number, default: 0 },
        monthlyLimit: { type: Number, default: 30 }, // Ücretsiz aylık limit (dakika)
        lastReset: { type: Date, default: () => new Date() },
        monthlyResetAt: { type: Date, default: () => {
          const now = new Date();
          return new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }},
      },
      // OCR kullanım sayaçları (günlük adet)
      ocrUsage: {
        day: { type: String, default: null }, // YYYY-MM-DD
        count: { type: Number, default: 0 }
      },
    },
    { timestamps: true }
  );

  // Eski abonelik modelini kullanmayacağız, ancak mevcut verileri korumak için şimdilik siliyoruz
  const subscriptionSchema = new Schema({}, { strict: false });
  // Eski kullanım modelini kullanmayacağız, ancak mevcut verileri korumak için şimdilik siliyoruz
  const usageSchema = new Schema({}, { strict: false });

export const User = model('User', userSchema);
export const Subscription = model('Subscription', subscriptionSchema);
export const Usage = model('Usage', usageSchema);
const paymentSchema = new Schema(
  {
    provider: { type: String, default: 'paytr', index: true },
    merchant_oid: { type: String, required: true, unique: true, index: true },
    uid: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    plan: { type: String, enum: ['free', 'starter', 'pro'], required: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending', index: true },
    total_amount: { type: Number, default: null },
    currency: { type: String, default: 'TL' },
    paidAt: { type: Date, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export const Payment = model('Payment', paymentSchema);

// Gamification: Streak (consecutive active days)
const streakSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lastDay: { type: String, required: true }, // YYYY-MM-DD (last day with activity)
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);
streakSchema.index({ userId: 1 }, { unique: true });

// Gamification: Achievements (unlocked keys)
const achievementSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    key: { type: String, required: true }, // e.g. 'streak_3', 'streak_7', 'daily_10'
    unlockedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);
achievementSchema.index({ userId: 1, key: 1 }, { unique: true });

// Gamification: Daily Goal (minutes)
const goalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dailyMinutes: { type: Number, default: 10 },
    lastMetDate: { type: String, default: null }, // YYYY-MM-DD when met
  },
  { timestamps: true }
);
goalSchema.index({ userId: 1 }, { unique: true });

export const Streak = model('Streak', streakSchema);
export const Achievement = model('Achievement', achievementSchema);
export const Goal = model('Goal', goalSchema);

// Daily Challenge completion per day
const dailyChallengeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dateBucket: { type: String, required: true, index: true }, // YYYY-MM-DD
    scenarioId: { type: String, default: null },
    minutes: { type: Number, default: 0 },
    completedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);
dailyChallengeSchema.index({ userId: 1, dateBucket: 1 }, { unique: true });

export const DailyChallenge = model('DailyChallenge', dailyChallengeSchema);

// Analytics: minimal request logs
const analyticsSchema = new Schema(
  {
    path: { type: String, index: true },
    referrer: { type: String, default: null },
    userAgent: { type: String, default: null },
    ipHash: { type: String, index: true },
    ipRaw: { type: String, default: null },
    country: { type: String, default: null, index: true },
    countrySource: { type: String, default: null },
    city: { type: String, default: null },
    region: { type: String, default: null },
    anonId: { type: String, default: null },
    uid: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    ts: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false }
);
analyticsSchema.index({ ts: 1 });

export const Analytics = model('Analytics', analyticsSchema);

