import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../db.js";
import { aggregateDailyStatsForAllBusinesses, dayStart } from "./aggregateDailyStats.js";

/* One-off backfill for historical feedbackSessions that predate the nightly
   cron. Usage:
     node src/jobs/backfillDailyStats.js --days=30
   Aggregates every day from (today - days) through yesterday, across every
   business. Safe to re-run — each day upserts, never duplicates. */

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 30;

await connectDB();

const today = dayStart();
for (let i = days; i >= 1; i--) {
  const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
  const result = await aggregateDailyStatsForAllBusinesses(date);
  console.log(`${date.toISOString().slice(0, 10)} — ${result.ok}/${result.total} businesses` + (result.failed.length ? `, ${result.failed.length} failed` : ""));
  if (result.failed.length) console.error(result.failed);
}

console.log(`Backfilled ${days} day(s).`);
await mongoose.disconnect();
