import mongoose from "mongoose";

// One doc per business per day, built from feedbackSessions by the nightly
// aggregation job. Dashboards read this instead of scanning raw sessions —
// fine at 10 businesses, painful at 200. Always store sums and counts, never
// pre-computed averages: averaging averages across a date range gives wrong
// answers, and it's the kind of bug that only surfaces when an owner
// disputes a number.
const dailyStatSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  date: { type: Date, required: true }, // normalized to midnight UTC for that day

  scans: { type: Number, default: 0 },
  rated: { type: Number, default: 0 },
  drafted: { type: Number, default: 0 },
  copied: { type: Number, default: 0 },
  clicked: { type: Number, default: 0 },

  ratingSum: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  ratingDist: {
    1: { type: Number, default: 0 },
    2: { type: Number, default: 0 },
    3: { type: Number, default: 0 },
    4: { type: Number, default: 0 },
    5: { type: Number, default: 0 },
  },

  byHour: [{ _id: false, hour: Number, sessions: Number, ratingSum: Number, ratingCount: Number }],

  items: [{
    _id: false,
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" },
    mentions: Number,
    ratingSum: Number,
    ratingCount: Number,
    fiveStar: Number, // mentions where that session rated 5
    threeOrBelow: Number, // mentions where that session rated <= 3
  }],

  aspects: [{ _id: false, aspect: String, total: Number, lowRated: Number, highRated: Number }],

  devices: {
    android: { type: Number, default: 0 },
    ios: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
  },
});

// One doc per (businessId, date) — the aggregation job upserts on this so a
// retry never double-counts.
dailyStatSchema.index({ businessId: 1, date: -1 }, { unique: true });

export default mongoose.model("DailyStat", dailyStatSchema);
