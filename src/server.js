import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import adminRoutes from "./routes/admin.js";
import businessRoutes from "./routes/business.js";
import publicRoutes from "./routes/public.js";
import { connectDB } from "./db.js";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

// CORS_ORIGIN is optional (comma-separated) — unset keeps the original
// allow-all behavior so nothing breaks without extra config.
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Ensure the cached, pooled DB connection is ready before any route runs —
// required for serverless, where a cold start has no connection yet.
app.use((req, res, next) => {
  connectDB().then(() => next()).catch(next);
});

app.use("/admin", adminRoutes);
app.use("/business", businessRoutes);
app.use("/", publicRoutes);

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
