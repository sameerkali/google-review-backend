import mongoose from "mongoose";
import Business from "../models/Business.js";
import FeedbackSession from "../models/FeedbackSession.js";
import DailyStat from "../models/DailyStat.js";

/** Midnight UTC for the given date (or today). Kept simple/UTC rather than
    IST-adjusted — day boundaries will be a few hours off from a cafe's local
    midnight until this is revisited, but every doc is at least consistent
    with every other, which is what the averaging math actually depends on. */
export function dayStart(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function classifyDevice(os) {
  if (os === "android") return "android";
  if (os === "ios") return "ios";
  return "other";
}

/** Pure aggregation over an arbitrary [from, to) window — no persistence, no
    day-boundary assumption. Used both by the nightly per-day job below and
    by the dashboard's live "today" merge (see businessDashboard.js), so the
    exact same counting logic backs a stored day and an in-progress one. */
export async function computeStats(businessId, from, to) {
  const bizId = new mongoose.Types.ObjectId(businessId);
  const sessions = await FeedbackSession.find({
    businessId: bizId,
    startedAt: { $gte: from, $lt: to },
  }).lean();

  const doc = {
    scans: sessions.length,
    rated: 0,
    drafted: 0,
    copied: 0,
    clicked: 0,
    draftEditedCount: 0,
    ratingSum: 0,
    ratingCount: 0,
    ratingDist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: 0, ratingSum: 0, ratingCount: 0 })),
    items: [],
    aspects: [],
    devices: { android: 0, ios: 0, other: 0 },
    referrer: { qr: 0, nfc: 0, direct: 0 },
  };

  const itemMap = new Map(); // menuItemId -> { mentions, ratingSum, ratingCount }
  const aspectMap = new Map(); // aspect -> { total, lowRated, highRated }

  for (const s of sessions) {
    const hour = new Date(s.startedAt).getUTCHours();
    doc.byHour[hour].sessions += 1;

    if (s.draftGenerated) doc.drafted += 1;
    if (s.copiedAt) {
      doc.copied += 1;
      if (s.draftEdited) doc.draftEditedCount += 1;
    }
    if (s.googleClickedAt) doc.clicked += 1;
    doc.devices[classifyDevice(s.device?.os)] += 1;
    doc.referrer[s.referrerType === "nfc" || s.referrerType === "direct" ? s.referrerType : "qr"] += 1;

    if (typeof s.rating === "number" && s.rating >= 1 && s.rating <= 5) {
      doc.rated += 1;
      doc.ratingSum += s.rating;
      doc.ratingCount += 1;
      doc.ratingDist[s.rating] += 1;
      doc.byHour[hour].ratingSum += s.rating;
      doc.byHour[hour].ratingCount += 1;

      const isLow = s.rating <= 3;
      for (const itemId of s.menuItemIds || []) {
        const key = String(itemId);
        const entry = itemMap.get(key) || { mentions: 0, ratingSum: 0, ratingCount: 0, fiveStar: 0, threeOrBelow: 0 };
        entry.mentions += 1;
        entry.ratingSum += s.rating;
        entry.ratingCount += 1;
        if (s.rating === 5) entry.fiveStar += 1;
        if (isLow) entry.threeOrBelow += 1;
        itemMap.set(key, entry);
      }
      for (const aspect of s.aspects || []) {
        const entry = aspectMap.get(aspect) || { total: 0, lowRated: 0, highRated: 0 };
        entry.total += 1;
        if (isLow) entry.lowRated += 1;
        else entry.highRated += 1;
        aspectMap.set(aspect, entry);
      }
    }
  }

  doc.items = [...itemMap.entries()].map(([menuItemId, v]) => ({ menuItemId, ...v }));
  doc.aspects = [...aspectMap.entries()].map(([aspect, v]) => ({ aspect, ...v }));

  return doc;
}

/** Aggregates one business's feedbackSessions for one UTC day and persists it
    as a DailyStat doc (upserted — safe to re-run for the same businessId+date). */
export async function aggregateDailyStatsForBusiness(businessId, date) {
  const from = dayStart(date);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const bizId = new mongoose.Types.ObjectId(businessId);
  const stats = await computeStats(bizId, from, to);
  const doc = { businessId: bizId, date: from, ...stats };

  await DailyStat.findOneAndUpdate(
    { businessId: bizId, date: from },
    { $set: doc },
    { upsert: true }
  );
  return doc;
}

// How many businesses to aggregate concurrently — fully sequential becomes
// the long pole in the nightly job as the business count grows; fully
// parallel risks overwhelming the (deliberately small, see db.js) connection
// pool. A small fixed batch size is a safe middle ground.
const AGGREGATION_CONCURRENCY = 5;

/** Runs the aggregation above for every business, for one UTC day, in
    batches rather than one at a time. Used by both the nightly cron endpoint
    and the backfill script. One business failing doesn't stop the rest. */
export async function aggregateDailyStatsForAllBusinesses(date) {
  const businesses = await Business.find().select("_id").lean();
  let ok = 0;
  const failed = [];
  for (let i = 0; i < businesses.length; i += AGGREGATION_CONCURRENCY) {
    const batch = businesses.slice(i, i + AGGREGATION_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((b) => aggregateDailyStatsForBusiness(b._id, date)));
    results.forEach((result, idx) => {
      if (result.status === "fulfilled") ok++;
      else failed.push({ businessId: String(batch[idx]._id), error: result.reason?.message });
    });
  }
  return { total: businesses.length, ok, failed };
}
