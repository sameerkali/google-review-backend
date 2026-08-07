import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import adminRoutes from "./routes/admin.js";
import publicRoutes from "./routes/public.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/admin", adminRoutes);
app.use("/", publicRoutes);

const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/qr_review_platform", {
    tls: true,
    serverSelectionTimeoutMS: 5000,
  })
  .then(() => {
    console.log("MongoDB connected ✓");
    app.listen(PORT, () => console.log(`API on :${PORT} (${process.env.NODE_ENV || "dev"})`));
  })
  .catch((e) => {
    console.error("Mongo connect failed:", e.message);
    process.exit(1);
  });