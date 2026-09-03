import { Router } from "express";
import { aggregateDailyStatsForAllBusinesses, dayStart } from "../jobs/aggregateDailyStats.js";
import { ah } from "../utils/asyncHandler.js";
import { cronLimiter } from "../middleware/rateLimit.js";

/* Nightly dailyStats aggregation, triggered by Vercel Cron rather than a
   BullMQ+Redis repeatable job — there's no Redis infra in this deployment,
   and Vercel Cron (see vercel.json) gives the same "runs once a day"
   guarantee without provisioning anything new. Re-running for the same day
   is safe (aggregateDailyStatsForBusiness upserts), so a retry never
   double-counts. */

// In a deployed environment this endpoint MUST be behind a secret — without
// one it's a public "recompute analytics for every business" trigger with no
// rate limit of its own, i.e. a free DoS/cost-amplification lever. Only local
// dev (no VERCEL, no NODE_ENV=production) is allowed to run without it.
if ((process.env.VERCEL || process.env.NODE_ENV === "production") && !process.env.CRON_SECRET) {
  throw new Error("CRON_SECRET environment variable is required in production/Vercel deployments");
}

const r = Router();
r.use(cronLimiter);

// Vercel Cron sends a GET request to trigger the job.
r.get("/daily-stats", ah(async (req, res) => {
  // Vercel signs cron requests with this header when CRON_SECRET is set —
  // reject anything else so this isn't a public "recompute everything" endpoint.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Defaults to yesterday (UTC) — the day that just fully closed when this
  // fires at 2am. ?date=YYYY-MM-DD lets the backfill script or a manual
  // retry target a specific day instead.
  const target = req.query.date ? new Date(req.query.date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await aggregateDailyStatsForAllBusinesses(dayStart(target));
  res.json({ date: dayStart(target).toISOString().slice(0, 10), ...result });
}));

export default r;
