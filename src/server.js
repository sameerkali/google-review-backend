import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import adminRoutes from "./routes/admin.js";
import businessRoutes from "./routes/business.js";
import businessDashboardRoutes from "./routes/businessDashboard.js";
import feedbackRoutes from "./routes/feedback.js";
import cronRoutes from "./routes/cron.js";
import { connectDB } from "./db.js";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

// CORS_ORIGIN is optional (comma-separated) — unset keeps the original
// allow-all behavior so nothing breaks without extra config. That's fine for
// local dev, but a deployed API serving bearer-token-authenticated requests
// should have an explicit allowlist — warn loudly (not a hard failure, since
// an API that refuses to boot is worse than one that's temporarily too open).
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
if (!corsOrigins?.length && (process.env.VERCEL || process.env.NODE_ENV === "production")) {
  console.error("WARNING: CORS_ORIGIN is not set in a production deployment — allowing all origins. Set CORS_ORIGIN to your frontend's URL(s).");
}
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));

// Bumped from the 100kb default — the admin JSON bulk-menu-upload endpoint
// (POST /admin/menu-items/bulk) needs headroom for a full exported menu file.
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Ensure the cached, pooled DB connection is ready before any route runs —
// required for serverless, where a cold start has no connection yet.
app.use((req, res, next) => {
  connectDB().then(() => next()).catch(next);
});

app.use("/admin", adminRoutes);
app.use("/business", businessRoutes);
app.use("/business/dashboard", businessDashboardRoutes);
app.use("/api/v1/feedback", feedbackRoutes);
app.use("/internal/cron", cronRoutes);

// Central error handler — every route is wrapped with ah() so thrown/rejected
// errors land here instead of crashing the process via an unhandled rejection.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "value";
    return res.status(409).json({ error: `${field} already in use` });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(", ") });
  }
  if (err.name === "CastError") {
    return res.status(400).json({ error: `Invalid ${err.path}` });
  }
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;

// Vercel imports this module as a serverless handler and invokes the
// exported app directly (see vercel.json) — it must not bind a port itself.
// Locally there's no Vercel runtime, so listen normally.
if (!process.env.VERCEL) {
  connectDB()
    .then(() => app.listen(PORT, () => console.log(`API on :${PORT} (${process.env.NODE_ENV || "dev"})`)))
    .catch((e) => {
      console.error("Mongo connect failed:", e.message);
      process.exit(1);
    });
}

export default app;
