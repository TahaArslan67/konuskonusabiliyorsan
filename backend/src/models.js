import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// User schema
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    preferredLanguage: { type: String, default: null }, // e.g., 'tr', 'en'
    preferredVoice: { type: String, default: null }, // e.g., 'alloy'
    preferredCorrectionMode: { type: String, default: 'gentle' }, // 'off' | 'gentle' | 'strict'
    preferredLearningLanguage: { type: String, default: 'en' }, // hedef/öğrenilen dil (BCP-47)
    preferredNativeLanguage: { type: String, default: 'tr' }, // kullanıcının ana dili (BCP-47)
    placementLevel: { type: String, default: null }, // A1 | A2 | B1 | B2 | C1 | C2 (kısa test sonucu)
    placementCompletedAt: { type: Date, default: null },
    verifyToken: { type: String, default: null },
    verifyExpires: { type: Date, default: null },
    resetToken: { type: String, default: null },
    resetExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

// Subscription schema
const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    plan: { type: String, required: true }, // starter | pro | enterprise
    status: { type: String, required: true }, // active | canceled | past_due | trialing
    currentPeriodEnd: { type: Date, default: null },
    stripeCustomerId: { type: String, default: null },
    stripeSubId: { type: String, default: null },
  },
  { timestamps: true }
);

// Usage schema (daily/monthly minutes per user)
const usageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dateBucket: { type: String, required: true, index: true }, // YYYY-MM-DD
    monthBucket: { type: String, required: true, index: true }, // YYYY-MM
    minutes: { type: Number, default: 0 },
  },
  { timestamps: true }
);
usageSchema.index({ userId: 1, dateBucket: 1 }, { unique: true });
usageSchema.index({ userId: 1, monthBucket: 1 });

export const User = model('User', userSchema);
export const Subscription = model('Subscription', subscriptionSchema);
export const Usage = model('Usage', usageSchema);

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

