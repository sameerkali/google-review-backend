import { Router } from "express";
import Business from "../models/Business.js";
import Plan from "../models/Plan.js";
import Hardware from "../models/Hardware.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import ReviewSuggestion from "../models/ReviewSuggestion.js";
import { adminAuth, signAdmin } from "../middleware/auth.js";

const r = Router();

r.post("/login", (req, res) => {
  const adminPass = process.env.ADMIN_PASSWORD || "admin";
  return req.body.password === adminPass
    ? res.json({ token: signAdmin() })
    : res.status(401).json({ error: "invalid password" });
});

r.use(adminAuth);

r.post("/business", async (req, res) => {
  const b = await Business.create(req.body);
  const hard = await Hardware.updateMany(
    { serial: { $in: req.body.serial || [] } },
    { assignedBusinessId: b._id, status: "assigned" }
  );
  res.status(201).json({ ...b.toObject(), hardwareAssigned: hard.modifiedCount });
});

r.put("/business/:id", async (req, res) => {
  const b = await Business.findByIdAndUpdate(req.params.id, req.body, { new: true });
  return b ? res.json(b) : res.status(404).json({ error: "not found" });
});

r.get("/business", async (req, res) => {
  const list = await Business.find().populate("planId").sort({ createdAt: -1 });
  res.json(list);
});

r.delete("/business/:id", async (req, res) => {
  await Business.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

r.post("/hardware", async (req, res) => {
  const items = req.body.items || [req.body];
  const created = await Hardware.insertMany(items);
  res.status(201).json(created);
});

r.get("/hardware", async (req, res) => {
  const list = await Hardware.find().populate("assignedBusinessId").sort({ createdAt: -1 });
  res.json(list);
});

r.post("/assign", async (req, res) => {
  const { serial, businessId } = req.body;
  const h = await Hardware.findOneAndUpdate(
    { serial },
    { assignedBusinessId: businessId, status: "assigned" },
    { new: true }
  );
  return h ? res.json(h) : res.status(404).json({ error: "hardware not found" });
});

r.post("/plans", async (req, res) => {
  const p = await Plan.create(req.body);
  res.status(201).json(p);
});

r.put("/plans/:id", async (req, res) => {
  const p = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true });
  return p ? res.json(p) : res.status(404).json({ error: "not found" });
});

r.get("/plans", async (_req, res) => res.json(await Plan.find()));

r.post("/review-suggestions", async (req, res) => {
  const s = await ReviewSuggestion.create(req.body);
  res.status(201).json(s);
});

r.get("/review-suggestions", async (_req, res) =>
  res.json(await ReviewSuggestion.find().populate("businessId").sort({ createdAt: -1 }))
);

r.get("/analytics", async (req, res) => {
  const q = {};
  if (req.query.businessId) q.businessId = req.query.businessId;
  const rows = await AnalyticsEvent.find(q).sort({ createdAt: -1 }).limit(500);
  const summary = {
    total: rows.length,
    byType: {
      scan: rows.filter((x) => x.eventType === "scan").length,
      google_click: rows.filter((x) => x.eventType === "google_click").length,
      review_copy: rows.filter((x) => x.eventType === "review_copy").length,
    },
  };
  res.json({ summary, rows });
});

r.get("/overview", async (_req, res) => {
  const [businesses, activeBusinesses, hardware, events] = await Promise.all([
    Business.countDocuments(),
    Business.countDocuments({ status: "active" }),
    Hardware.countDocuments(),
    AnalyticsEvent.countDocuments(),
  ]);
  res.json({ businesses, activeBusinesses, hardware, events });
});

export default r;