import { Router } from "express";
import mongoose from "mongoose";
import Business from "../models/Business.js";
import DailyStat from "../models/DailyStat.js";
import MenuItem from "../models/MenuItem.js";
import FeedbackSession from "../models/FeedbackSession.js";
import { businessAuth } from "../middleware/auth.js";
import { ah } from "../utils/asyncHandler.js";
import { computeStats, dayStart } from "../jobs/aggregateDailyStats.js";

const r = Router();
r.use(businessAuth);

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };
const TIER_ORDER = { none: 0, basic: 1, full: 2 };

/** Reads the plan's analytics tier fresh from the DB on every call — never
    trusted from a token claim — so a downgrade takes effect on the very next
    request instead of whenever the business happens to log in again. On a
    tier that's too low, responds 403 but still includes totalScans so the
    free/no-plan view can show "data is still being collected" rather than
    a blank screen. Returns null (after responding) when access is denied,
    the same "handled, caller returns" shape asyncHandler expects elsewhere. */
async function requireTier(req, res, minTier) {
  const business = await Business.findById(req.businessId).populate("planId").lean();
  const level = business?.planId?.features?.analytics || "none";
  if (TIER_ORDER[level] < TIER_ORDER[minTier]) {
    const totalScans = await FeedbackSession.countDocuments({ businessId: req.businessId });
    res.status(403).json({
      error: level === "none" ? "Reports are paused on your current plan." : "This is a Full-plan feature.",
      tier: level,
      totalScans,
    });
    return null;
  }
  return business;
}

function resolveRange(rangeParam) {
  const days = RANGE_DAYS[rangeParam] || 30;
  const to = dayStart(); // exclusive — "today" is handled separately as a live merge
  const from = new Date(to.getTime() - days * 86400000);
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - days * 86400000);
  return { days, from, to, prevFrom, prevTo };
}

/** Stored days [from,to) plus today's still-accumulating totals computed live
    from feedbackSessions — the dashboard never makes an owner wait until
    tomorrow to see today's scans. */
async function loadDayDocs(businessId, from, to) {
  const stored = await DailyStat.find({ businessId, date: { $gte: from, $lt: to } }).sort({ date: 1 }).lean();
  const todayStart = dayStart();
  if (to > todayStart) {
    const live = await computeStats(businessId, todayStart, new Date());
    stored.push({ date: todayStart, ...live });
  }
  return stored;
}

async function getRangeData(businessId, rangeParam) {
  const { from, to, prevFrom, prevTo } = resolveRange(rangeParam);
  const [dayDocs, prevDocs] = await Promise.all([
    loadDayDocs(businessId, from, to),
    DailyStat.find({ businessId, date: { $gte: prevFrom, $lt: prevTo } }).sort({ date: 1 }).lean(),
  ]);
  return { dayDocs, prevDocs, from, to, prevFrom, prevTo };
}

function emptyTotals() {
  return {
    scans: 0, rated: 0, drafted: 0, copied: 0, clicked: 0, draftEditedCount: 0,
    ratingSum: 0, ratingCount: 0,
    ratingDist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: 0, ratingSum: 0, ratingCount: 0 })),
    itemsMap: new Map(),
    aspectsMap: new Map(),
    devices: { android: 0, ios: 0, other: 0 },
    referrer: { qr: 0, nfc: 0, direct: 0 },
  };
}

/** Sums a list of daily docs (persisted DailyStat rows and/or a live
    "today" doc — same shape) into one totals object. Sums and counts only,
    never averages of averages — averages are derived once, at the edge,
    from the combined sum/count. */
function sumDocs(docs) {
  const t = emptyTotals();
  for (const d of docs) {
    t.scans += d.scans || 0;
    t.rated += d.rated || 0;
    t.drafted += d.drafted || 0;
    t.copied += d.copied || 0;
    t.clicked += d.clicked || 0;
    t.draftEditedCount += d.draftEditedCount || 0;
    t.ratingSum += d.ratingSum || 0;
    t.ratingCount += d.ratingCount || 0;
    for (const k of [1, 2, 3, 4, 5]) t.ratingDist[k] += d.ratingDist?.[k] || 0;
    for (const h of d.byHour || []) {
      t.byHour[h.hour].sessions += h.sessions || 0;
      t.byHour[h.hour].ratingSum += h.ratingSum || 0;
      t.byHour[h.hour].ratingCount += h.ratingCount || 0;
    }
    for (const it of d.items || []) {
      const key = String(it.menuItemId);
      const e = t.itemsMap.get(key) || { mentions: 0, ratingSum: 0, ratingCount: 0, fiveStar: 0, threeOrBelow: 0 };
      e.mentions += it.mentions || 0;
      e.ratingSum += it.ratingSum || 0;
      e.ratingCount += it.ratingCount || 0;
      e.fiveStar += it.fiveStar || 0;
      e.threeOrBelow += it.threeOrBelow || 0;
      t.itemsMap.set(key, e);
    }
    for (const a of d.aspects || []) {
      const e = t.aspectsMap.get(a.aspect) || { total: 0, lowRated: 0, highRated: 0 };
      e.total += a.total || 0;
      e.lowRated += a.lowRated || 0;
      e.highRated += a.highRated || 0;
      t.aspectsMap.set(a.aspect, e);
    }
    for (const dk of ["android", "ios", "other"]) t.devices[dk] += d.devices?.[dk] || 0;
    for (const rk of ["qr", "nfc", "direct"]) t.referrer[rk] += d.referrer?.[rk] || 0;
  }
  return t;
}

const avgOf = (sum, count) => (count ? +(sum / count).toFixed(2) : null);

async function getRecentActivity(businessId) {
  const sessions = await FeedbackSession.find({ businessId, rating: { $ne: null } })
    .sort({ startedAt: -1 })
    .limit(8)
    .populate("menuItemIds", "name")
    .select("rating aspects startedAt menuItemIds freeTextItem")
    .lean();
  return sessions.map((s) => ({
    rating: s.rating,
    items: [...(s.menuItemIds || []).map((m) => m.name), ...(s.freeTextItem ? [s.freeTextItem] : [])],
    aspects: s.aspects || [],
    startedAt: s.startedAt,
  }));
}

// ── Basic tier ───────────────────────────────────────────────────────────────

r.get("/summary", ah(async (req, res) => {
  if (!(await requireTier(req, res, "basic"))) return;
  const { dayDocs, prevDocs } = await getRangeData(req.businessId, req.query.range);
  const cur = sumDocs(dayDocs);
  const prev = sumDocs(prevDocs);
  const hasPrev = prevDocs.length > 0;

  res.json({
    reviewsStarted: { value: cur.rated, prev: hasPrev ? prev.rated : null },
    avgRating: { value: avgOf(cur.ratingSum, cur.ratingCount), ratingCount: cur.ratingCount, prev: hasPrev ? avgOf(prev.ratingSum, prev.ratingCount) : null, prevRatingCount: prev.ratingCount },
    googleClicks: { value: cur.clicked, prev: hasPrev ? prev.clicked : null },
    completionRate: { value: cur.scans ? +(cur.clicked / cur.scans * 100).toFixed(1) : 0, prev: hasPrev && prev.scans ? +(prev.clicked / prev.scans * 100).toFixed(1) : null },
    // Of the sessions that got copied, how many the customer edited first —
    // a quality signal on the draft engine, not on the business. Null (not
    // 0) with no copies yet, same "don't show a number that isn't real yet"
    // rule as avgRating below 5 ratings.
    draftEditRate: {
      value: cur.copied ? +(cur.draftEditedCount / cur.copied * 100).toFixed(1) : null,
      copiedCount: cur.copied,
      prev: hasPrev && prev.copied ? +(prev.draftEditedCount / prev.copied * 100).toFixed(1) : null,
    },
    recentActivity: await getRecentActivity(req.businessId),
  });
}));

r.get("/ratings", ah(async (req, res) => {
  if (!(await requireTier(req, res, "basic"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);

  const series = dayDocs.map((d, i) => {
    const windowDocs = dayDocs.slice(Math.max(0, i - 6), i + 1);
    const windowSum = windowDocs.reduce((a, x) => a + (x.ratingSum || 0), 0);
    const windowCount = windowDocs.reduce((a, x) => a + (x.ratingCount || 0), 0);
    return {
      date: new Date(d.date).toISOString().slice(0, 10),
      avg: avgOf(d.ratingSum, d.ratingCount),
      count: d.ratingCount || 0,
      rolling7d: avgOf(windowSum, windowCount),
    };
  });
  const totals = sumDocs(dayDocs);
  res.json({ series, distribution: totals.ratingDist, ratingCount: totals.ratingCount });
}));

r.get("/funnel", ah(async (req, res) => {
  if (!(await requireTier(req, res, "basic"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);
  const t = sumDocs(dayDocs);
  res.json({
    stages: [
      { key: "scans", label: "Scans", value: t.scans },
      { key: "rated", label: "Rated", value: t.rated },
      { key: "drafted", label: "Drafted", value: t.drafted },
      { key: "copied", label: "Copied", value: t.copied },
      { key: "clicked", label: "Google clicked", value: t.clicked },
    ],
  });
}));

r.get("/timing", ah(async (req, res) => {
  if (!(await requireTier(req, res, "basic"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);
  const t = sumDocs(dayDocs);

  const byHour = t.byHour.map((h) => ({ hour: h.hour, scans: h.sessions, avgRating: avgOf(h.ratingSum, h.ratingCount) }));
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, scans: 0 }));
  for (const d of dayDocs) byWeekday[new Date(d.date).getUTCDay()].scans += d.scans || 0;

  res.json({ byHour, byWeekday });
}));

r.get("/devices", ah(async (req, res) => {
  if (!(await requireTier(req, res, "basic"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);
  const t = sumDocs(dayDocs);
  // Same request as the phone/OS split — one already-computed field, no
  // extra round trip for what's really the same "where did this scan come
  // from" question (device vs hardware).
  res.json({ devices: t.devices, referrer: t.referrer });
}));

// ── Full tier ────────────────────────────────────────────────────────────────

r.get("/menu", ah(async (req, res) => {
  if (!(await requireTier(req, res, "full"))) return;
  const { dayDocs, prevDocs } = await getRangeData(req.businessId, req.query.range);
  const cur = sumDocs(dayDocs);
  const prev = sumDocs(prevDocs);

  const itemIds = [...new Set([...cur.itemsMap.keys(), ...prev.itemsMap.keys()])];
  const menuItems = await MenuItem.find({ _id: { $in: itemIds } }).select("name").lean();
  const nameMap = new Map(menuItems.map((m) => [String(m._id), m.name]));

  const rows = itemIds.map((id) => {
    const c = cur.itemsMap.get(id) || { mentions: 0, ratingSum: 0, ratingCount: 0, fiveStar: 0, threeOrBelow: 0 };
    const p = prev.itemsMap.get(id);
    const avgRating = avgOf(c.ratingSum, c.ratingCount);
    const prevAvg = p ? avgOf(p.ratingSum, p.ratingCount) : null;
    const trend = avgRating == null || prevAvg == null ? "flat" : avgRating > prevAvg + 0.1 ? "up" : avgRating < prevAvg - 0.1 ? "down" : "flat";
    return {
      menuItemId: id,
      name: nameMap.get(id) || "Unknown item",
      mentions: c.mentions,
      avgRating,
      trend,
      fiveStarShare: c.mentions ? +(c.fiveStar / c.mentions * 100).toFixed(0) : 0,
      threeOrBelowShare: c.mentions ? +(c.threeOrBelow / c.mentions * 100).toFixed(0) : 0,
      lowData: c.mentions < 5,
    };
  });

  const sort = req.query.sort === "rating" ? (a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) : (a, b) => b.mentions - a.mentions;
  res.json({ items: rows.sort(sort) });
}));

r.get("/aspects", ah(async (req, res) => {
  if (!(await requireTier(req, res, "full"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);
  const t = sumDocs(dayDocs);
  const rows = [...t.aspectsMap.entries()]
    .map(([aspect, v]) => ({ aspect, total: v.total, lowRated: v.lowRated, highRated: v.highRated }))
    .sort((a, b) => b.total - a.total);
  res.json({ aspects: rows });
}));

// Default hour bands — customizable bands (per-business settings) are a
// follow-up; every business gets the same four shifts for now.
const SHIFT_BANDS = [
  { label: "Morning (8–12)", startHour: 8, endHour: 12 },
  { label: "Afternoon (12–16)", startHour: 12, endHour: 16 },
  { label: "Evening (16–20)", startHour: 16, endHour: 20 },
  { label: "Night (20–24)", startHour: 20, endHour: 24 },
];

r.get("/shifts", ah(async (req, res) => {
  if (!(await requireTier(req, res, "full"))) return;
  const { dayDocs } = await getRangeData(req.businessId, req.query.range);
  const t = sumDocs(dayDocs);
  const bands = SHIFT_BANDS.map((b) => {
    let sessions = 0, ratingSum = 0, ratingCount = 0;
    for (let h = b.startHour; h < b.endHour; h++) {
      sessions += t.byHour[h].sessions;
      ratingSum += t.byHour[h].ratingSum;
      ratingCount += t.byHour[h].ratingCount;
    }
    return { label: b.label, sessions, avgRating: avgOf(ratingSum, ratingCount), lowData: sessions < 10 };
  });
  res.json({ bands });
}));

r.get("/compare", ah(async (req, res) => {
  if (!(await requireTier(req, res, "full"))) return;
  const { aFrom, aTo, bFrom, bTo } = req.query;
  if (!aFrom || !aTo || !bFrom || !bTo) return res.status(400).json({ error: "aFrom, aTo, bFrom, bTo are required (YYYY-MM-DD)" });

  const periodTotals = async (fromStr, toStr) => {
    const from = dayStart(new Date(fromStr));
    const to = dayStart(new Date(toStr));
    return sumDocs(await loadDayDocs(req.businessId, from, to));
  };
  const summarize = (t) => ({
    scans: t.scans,
    rated: t.rated,
    clicked: t.clicked,
    avgRating: avgOf(t.ratingSum, t.ratingCount),
    completionRate: t.scans ? +(t.clicked / t.scans * 100).toFixed(1) : 0,
  });

  const [a, b] = await Promise.all([periodTotals(aFrom, aTo), periodTotals(bFrom, bTo)]);
  res.json({ a: summarize(a), b: summarize(b) });
}));

r.get("/suggestions", ah(async (req, res) => {
  if (!(await requireTier(req, res, "full"))) return;
  const bizId = new mongoose.Types.ObjectId(req.businessId);
  const todayStart = dayStart();
  const from30 = new Date(todayStart.getTime() - 30 * 86400000);

  const [stored30, live] = await Promise.all([
    DailyStat.find({ businessId: bizId, date: { $gte: from30, $lt: todayStart } }).sort({ date: 1 }).lean(),
    computeStats(bizId, todayStart, new Date()),
  ]);
  const all30 = [...stored30, { date: todayStart, ...live }];
  const t30 = sumDocs(all30);

  const weekStart = new Date(todayStart.getTime() - 7 * 86400000);
  const twoWeekStart = new Date(todayStart.getTime() - 14 * 86400000);
  const scansThisWeek = all30.filter((d) => new Date(d.date) >= weekStart).reduce((a, d) => a + (d.scans || 0), 0);
  const scansLastWeek = stored30.filter((d) => new Date(d.date) >= twoWeekStart && new Date(d.date) < weekStart).reduce((a, d) => a + (d.scans || 0), 0);

  let eveningSum = 0, eveningCount = 0, eveningSessions = 0, daySum = 0, dayCount = 0;
  for (const h of t30.byHour) {
    if (h.hour >= 16) { eveningSum += h.ratingSum; eveningCount += h.ratingCount; eveningSessions += h.sessions; }
    else { daySum += h.ratingSum; dayCount += h.ratingCount; }
  }
  const eveningAvg = avgOf(eveningSum, eveningCount);
  const dayAvg = avgOf(daySum, dayCount);

  const t7 = sumDocs(all30.slice(-7));
  const avg7 = avgOf(t7.ratingSum, t7.ratingCount);
  const avg30 = avgOf(t30.ratingSum, t30.ratingCount);
  const completionRate = t30.scans ? t30.clicked / t30.scans : 0;
  const lowRatedTotal = [...t30.aspectsMap.values()].reduce((a, v) => a + v.lowRated, 0);

  const suggestions = [];
  if (t30.scans >= 10 && completionRate < 0.2) {
    suggestions.push("Completion is low. Codes on tables usually do better than at the counter.");
  }
  if (scansLastWeek >= 5 && scansThisWeek < scansLastWeek * 0.5) {
    suggestions.push("Scans dropped by half this week. Worth checking the posters are still up.");
  }
  if (t30.itemsMap.size) {
    const menuItems = await MenuItem.find({ _id: { $in: [...t30.itemsMap.keys()] } }).select("name").lean();
    const nameMap = new Map(menuItems.map((m) => [String(m._id), m.name]));
    for (const [id, v] of t30.itemsMap.entries()) {
      if (v.ratingCount >= 8 && v.ratingSum / v.ratingCount < 3.5) {
        suggestions.push(`${nameMap.get(id) || "An item"} is averaging ${(v.ratingSum / v.ratingCount).toFixed(1)} across ${v.ratingCount} mentions.`);
        break; // one item callout at a time, leaves room for other rule types
      }
    }
  }
  const speed = t30.aspectsMap.get("speed");
  if (lowRatedTotal >= 5 && speed && speed.lowRated > lowRatedTotal * 0.4) {
    suggestions.push("Speed is the most common complaint in low ratings.");
  }
  if (eveningAvg != null && dayAvg != null && eveningSessions >= 15 && eveningAvg < dayAvg - 0.7) {
    suggestions.push("Evening ratings are running below daytime. Worth a look at that shift.");
  }
  if (avg7 != null && avg30 != null && avg7 > avg30 + 0.3) {
    suggestions.push("Ratings are trending up this week.");
  }

  // Nothing rather than something generic — an empty panel beats "keep up
  // the good work," which is the fastest way to make an owner stop reading.
  res.json({ suggestions: suggestions.slice(0, 3) });
}));

// One bundled payload per range for the PDF report — the frontend calls this
// once per range (7d/30d/90d) instead of hitting five separate endpoints
// three times each. Same tier gate as everything else; full-tier sections
// are simply omitted for a basic plan rather than 403ing the whole report.
r.get("/report", ah(async (req, res) => {
  const business = await requireTier(req, res, "basic");
  if (!business) return;
  const tier = business.planId?.features?.analytics || "basic";

  const { dayDocs, prevDocs } = await getRangeData(req.businessId, req.query.range);
  const cur = sumDocs(dayDocs);
  const prev = sumDocs(prevDocs);
  const hasPrev = prevDocs.length > 0;

  const payload = {
    range: req.query.range && RANGE_DAYS[req.query.range] ? req.query.range : "30d",
    business: { name: business.name },
    tier,
    summary: {
      reviewsStarted: { value: cur.rated, prev: hasPrev ? prev.rated : null },
      avgRating: { value: avgOf(cur.ratingSum, cur.ratingCount), ratingCount: cur.ratingCount },
      googleClicks: { value: cur.clicked, prev: hasPrev ? prev.clicked : null },
      completionRate: { value: cur.scans ? +(cur.clicked / cur.scans * 100).toFixed(1) : 0 },
      draftEditRate: { value: cur.copied ? +(cur.draftEditedCount / cur.copied * 100).toFixed(1) : null },
    },
    distribution: cur.ratingDist,
    funnel: [
      { key: "scans", label: "Scans", value: cur.scans },
      { key: "rated", label: "Rated", value: cur.rated },
      { key: "drafted", label: "Drafted", value: cur.drafted },
      { key: "copied", label: "Copied", value: cur.copied },
      { key: "clicked", label: "Google clicked", value: cur.clicked },
    ],
    referrer: cur.referrer,
  };

  if (tier === "full") {
    const itemIds = [...cur.itemsMap.keys()];
    const menuItems = itemIds.length ? await MenuItem.find({ _id: { $in: itemIds } }).select("name").lean() : [];
    const nameMap = new Map(menuItems.map((m) => [String(m._id), m.name]));
    payload.menu = itemIds
      .map((id) => {
        const c = cur.itemsMap.get(id);
        return { name: nameMap.get(id) || "Unknown item", mentions: c.mentions, avgRating: avgOf(c.ratingSum, c.ratingCount) };
      })
      .sort((a, b) => b.mentions - a.mentions);

    payload.aspects = [...cur.aspectsMap.entries()]
      .map(([aspect, v]) => ({ aspect, total: v.total, lowRated: v.lowRated, highRated: v.highRated }))
      .sort((a, b) => b.total - a.total);
  }

  res.json(payload);
}));

export default r;
