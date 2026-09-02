import "dotenv/config";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { connectDB } from "./db.js";
import Business from "./models/Business.js";
import Hardware from "./models/Hardware.js";
import MenuItem from "./models/MenuItem.js";
import FeedbackSession from "./models/FeedbackSession.js";
import AnalyticsEvent from "./models/AnalyticsEvent.js";
import DailyStat from "./models/DailyStat.js";
import { aggregateDailyStatsForBusiness, dayStart } from "./jobs/aggregateDailyStats.js";

/* One-off: backfills ~4 months of realistic, growing scan/review activity
   for one real business so its dashboard has something to demo to
   prospects. Usage:
     node src/seedGrowthDemo.js --email=pin2@gmail.com [--days=112]
   Idempotent — clears and regenerates only this business's previously
   generated FeedbackSession/AnalyticsEvent/DailyStat docs, never touches
   the business, its menu, or other businesses. */

const emailArg = process.argv.find((a) => a.startsWith("--email="));
const EMAIL = emailArg ? emailArg.split("=")[1] : "pin2@gmail.com";
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? parseInt(daysArg.split("=")[1], 10) : 112; // ~3.7 months

const ASPECTS = ["staff", "speed", "taste", "portion", "price", "cleanliness", "ambience", "music"];
// A restaurant demo reads better when a handful of dishes clearly lead the
// board — weight these ~3x so the "Top items" panel isn't flat.
const POPULAR_ITEMS = [
  "Butter Chicken", "Chicken Biryani", "Paneer Tikka", "Dal Makhani",
  "Tandoori Chicken", "Chicken Tikka Masala", "Mutton Biryani", "Butter Naan",
  "Chole Bhature", "Paneer Butter Masala", "Pav Bhaji", "Chicken 65",
];

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function weightedPick(arr, weightFn) {
  const weights = arr.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

// Skewed toward 4-5 stars, but shifts a bit friendlier as `progress` (0..1
// across the seeded window) increases — the demo tells a "we got better"
// story, not a flat line.
function sampleRating(progress) {
  const lift = progress * 0.6; // late-window boost toward 4s/5s
  const weights = [
    3 - lift * 1.2,      // 1 star
    5 - lift * 1.5,      // 2 star
    14 - lift * 3,        // 3 star
    33 + lift * 4,        // 4 star
    45 + lift * 5,        // 5 star
  ].map((w) => Math.max(1, w));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < 5; i++) {
    r -= weights[i];
    if (r <= 0) return i + 1;
  }
  return 5;
}

function aspectsForRating(rating) {
  const count = randInt(0, 2);
  if (count === 0) return [];
  const positivePool = ["staff", "taste", "ambience", "cleanliness", "music"];
  const negativePool = ["speed", "price", "portion"];
  const pool = rating >= 4 ? [...positivePool, ...positivePool, ...negativePool] : [...negativePool, ...negativePool, ...positivePool];
  const chosen = new Set();
  while (chosen.size < count) chosen.add(pick(pool));
  return [...chosen];
}

function draftFor(rating, itemNames) {
  const thing = itemNames[0] || "the food";
  if (rating >= 5) return `${thing} was amazing, will definitely be back!`;
  if (rating === 4) return `${thing} was really good. Nice experience overall.`;
  if (rating === 3) return `${thing} was okay. Some things could be better.`;
  return `${thing} wasn't great this time. Hoping it improves.`;
}

// Weighted hour-of-day: lunch and dinner rushes, quiet late morning/late night.
const HOUR_WEIGHTS = [
  0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, // 0-7
  1.2, 1.5, 1.8, 2.5, 4.5, 5, 4, 2.5, // 8-15
  2, 2.5, 4, 5.5, 6, 5, 3.5, 1.5, // 16-23
];
function sampleHour() { return weightedPick([...Array(24).keys()], (h) => HOUR_WEIGHTS[h]); }

// Growth curve: slow start, ramping up, with weekday/weekend seasonality and
// day-to-day noise. Returns an integer scan count for that day.
function scansForDay(dayIndex, totalDays, weekday) {
  const progress = dayIndex / (totalDays - 1); // 0 → first day, 1 → last day
  const base = 3 + progress * progress * 34; // slow-then-fast ramp, 3 → ~37
  const weekendBoost = weekday === 0 || weekday === 6 ? 1.35 : 1;
  const noise = rand(0.7, 1.3);
  // Occasional slow day (posters down, rain, etc.) keeps it from looking synthetic.
  const dip = Math.random() < 0.06 ? rand(0.3, 0.6) : 1;
  return Math.max(0, Math.round(base * weekendBoost * noise * dip));
}

await connectDB();

const business = await Business.findOne({ email: EMAIL });
if (!business) {
  console.error(`No business found with email ${EMAIL}`);
  await mongoose.disconnect();
  process.exit(1);
}

const hardware = await Hardware.findOne({ assignedBusinessId: business._id, status: "assigned" });
if (!hardware) {
  console.error(`No hardware assigned to ${business.name} (${EMAIL}) — assign a QR code before seeding scans.`);
  await mongoose.disconnect();
  process.exit(1);
}

const menuItems = await MenuItem.find({ businessId: business._id, active: true }).lean();
if (!menuItems.length) {
  console.error(`No active menu items for ${business.name} — add a menu before seeding.`);
  await mongoose.disconnect();
  process.exit(1);
}
const itemWeight = (item) => (POPULAR_ITEMS.includes(item.name) ? 3 : 1);

// Clean slate for this business's generated activity — safe to re-run.
await FeedbackSession.deleteMany({ businessId: business._id });
await AnalyticsEvent.deleteMany({ businessId: business._id });
await DailyStat.deleteMany({ businessId: business._id });

const today = dayStart();
const sessionsDocs = [];
const eventDocs = [];

for (let dayIndex = 0; dayIndex < DAYS; dayIndex++) {
  const daysAgo = DAYS - 1 - dayIndex; // DAYS-1 → oldest, 0 → today
  const date = new Date(today.getTime() - daysAgo * 86400000);
  const weekday = date.getUTCDay();
  const scans = scansForDay(dayIndex, DAYS, weekday);
  const progress = dayIndex / (DAYS - 1);

  for (let i = 0; i < scans; i++) {
    const hour = sampleHour();
    const startedAt = new Date(date.getTime() + hour * 3600000 + randInt(0, 3599) * 1000);
    if (startedAt > new Date()) continue; // never seed into the future for "today"

    const os = Math.random() < 0.68 ? "android" : Math.random() < 0.9 ? "ios" : "other";
    const browser = os === "ios" ? "safari" : os === "android" ? (Math.random() < 0.85 ? "chrome" : "other") : pick(["chrome", "firefox", "safari"]);
    const sessionToken = crypto.randomBytes(18).toString("base64url");

    const rateThreshold = 0.78 + progress * 0.08; // completion improves slightly over time
    const doesRate = Math.random() < rateThreshold;

    const doc = {
      businessId: business._id,
      qrCodeId: hardware._id,
      sessionToken,
      startedAt,
      referrerType: "qr",
      device: { os, browser, isMobile: os !== "other" || Math.random() < 0.5 },
    };

    if (doesRate) {
      const rating = sampleRating(progress);
      const numItems = randInt(0, 3);
      const chosenItems = [];
      for (let n = 0; n < numItems; n++) {
        const item = weightedPick(menuItems, itemWeight);
        if (!chosenItems.find((c) => String(c._id) === String(item._id))) chosenItems.push(item);
      }
      const aspects = aspectsForRating(rating);
      doc.rating = rating;
      doc.menuItemIds = chosenItems.map((c) => c._id);
      doc.aspects = aspects;
      if (Math.random() < 0.08) doc.freeTextItem = pick(["the biryani", "service", "everything", "the ambience"]);

      const doesDraft = Math.random() < 0.93;
      if (doesDraft) {
        const draftGenerated = draftFor(rating, chosenItems.map((c) => c.name));
        doc.draftGenerated = draftGenerated;
        doc.completedAt = new Date(startedAt.getTime() + randInt(30, 90) * 1000);

        const copyThreshold = rating >= 4 ? 0.72 : 0.35;
        const doesCopy = Math.random() < copyThreshold;
        if (doesCopy) {
          doc.copiedAt = new Date(doc.completedAt.getTime() + randInt(5, 45) * 1000);
          doc.draftEdited = Math.random() < 0.25;
          doc.finalLength = draftGenerated.length + (doc.draftEdited ? randInt(-15, 40) : 0);

          const doesClick = Math.random() < 0.88;
          if (doesClick) {
            doc.googleClickedAt = new Date(doc.copiedAt.getTime() + randInt(3, 30) * 1000);
          }
        }
      }
    }

    sessionsDocs.push(doc);

    const commonEvent = { businessId: business._id, hardwareId: hardware._id, code: hardware.serial, os, browser, device: doc.device.isMobile ? "mobile" : "desktop" };
    eventDocs.push({ ...commonEvent, eventType: "scan", createdAt: startedAt, updatedAt: startedAt });
    if (doc.copiedAt) eventDocs.push({ ...commonEvent, eventType: "review_copy", createdAt: doc.copiedAt, updatedAt: doc.copiedAt });
    if (doc.googleClickedAt) eventDocs.push({ ...commonEvent, eventType: "google_click", createdAt: doc.googleClickedAt, updatedAt: doc.googleClickedAt });
  }
}

console.log(`Generated ${sessionsDocs.length} feedback sessions and ${eventDocs.length} analytics events across ${DAYS} days — inserting...`);
if (sessionsDocs.length) await FeedbackSession.insertMany(sessionsDocs, { ordered: false });
if (eventDocs.length) await AnalyticsEvent.insertMany(eventDocs, { ordered: false });

// Roll every day except today into DailyStat (today stays live-computed by
// the dashboard, matching how the nightly cron/backfill job behaves).
let aggregated = 0;
for (let daysAgo = DAYS - 1; daysAgo >= 1; daysAgo--) {
  const date = new Date(today.getTime() - daysAgo * 86400000);
  await aggregateDailyStatsForBusiness(business._id, date);
  aggregated++;
}

console.log(`Aggregated ${aggregated} days of DailyStat rows for ${business.name} (${EMAIL}).`);
console.log(`Done. Log into the business dashboard for ${EMAIL} to see ~${DAYS} days of growth.`);
await mongoose.disconnect();
