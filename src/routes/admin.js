import { Router } from "express";
import Business from "../models/Business.js";
import Plan from "../models/Plan.js";
import Hardware from "../models/Hardware.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import ReviewSuggestion from "../models/ReviewSuggestion.js";
import { adminAuth, signAdmin } from "../middleware/auth.js";
import { ah } from "../utils/asyncHandler.js";

const r = Router();

r.post("/login", (req, res) => {
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin";
  return req.body.username === adminUser && req.body.password === adminPass
    ? res.json({ token: signAdmin() })
    : res.status(401).json({ error: "invalid username or password" });
});

r.use(adminAuth);

r.post("/business", ah(async (req, res) => {
  const { serial, ...body } = req.body;
  const serials = (Array.isArray(serial) ? serial : serial ? [serial] : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

  const b = await Business.create(body);

  let hardwareAssigned = 0;
  let hardwareCreated = 0;
  for (const s of serials) {
    const existing = await Hardware.findOneAndUpdate(
      { serial: s },
      { assignedBusinessId: b._id, status: "assigned" },
      { new: true }
    );
    if (existing) {
      hardwareAssigned++;
    } else {
      // No hardware was pre-registered for this code — create it so the
      // business + QR are usable in a single step instead of silently failing.
      await Hardware.create({ type: "QR", serial: s, assignedBusinessId: b._id, status: "assigned" });
      hardwareCreated++;
    }
  }

  res.status(201).json({ ...b.toObject(), hardwareAssigned, hardwareCreated });
}));

r.put("/business/:id", ah(async (req, res) => {
  const b = await Business.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  return b ? res.json(b) : res.status(404).json({ error: "not found" });
}));

r.get("/business", ah(async (req, res) => {
  const list = await Business.find().populate("planId").sort({ createdAt: -1 });
  res.json(list);
}));

r.delete("/business/:id", ah(async (req, res) => {
  await Business.findByIdAndDelete(req.params.id);
  // Free up any hardware that was pointing at this business — otherwise it's
  // left showing "assigned" against a business that no longer exists.
  await Hardware.updateMany(
    { assignedBusinessId: req.params.id },
    { assignedBusinessId: null, status: "available" }
  );
  res.json({ ok: true });
}));

r.post("/hardware", ah(async (req, res) => {
  const items = req.body.items || [req.body];
  const created = await Hardware.insertMany(items);
  res.status(201).json(created);
}));

r.get("/hardware", ah(async (req, res) => {
  const list = await Hardware.find().populate("assignedBusinessId").sort({ createdAt: -1 });
  res.json(list);
}));

r.put("/hardware/:id", ah(async (req, res) => {
  const h = await Hardware.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    .populate("assignedBusinessId");
  return h ? res.json(h) : res.status(404).json({ error: "not found" });
}));

r.delete("/hardware/:id", ah(async (req, res) => {
  await Hardware.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

r.post("/assign", ah(async (req, res) => {
  const { serial, businessId } = req.body;
  const h = await Hardware.findOneAndUpdate(
    { serial },
    { assignedBusinessId: businessId, status: "assigned" },
    { new: true }
  );
  return h ? res.json(h) : res.status(404).json({ error: "hardware not found" });
}));

r.post("/plans", ah(async (req, res) => {
  const p = await Plan.create(req.body);
  res.status(201).json(p);
}));

r.put("/plans/:id", ah(async (req, res) => {
  const p = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  return p ? res.json(p) : res.status(404).json({ error: "not found" });
}));

r.get("/plans", ah(async (_req, res) => res.json(await Plan.find())));

r.post("/review-suggestions", ah(async (req, res) => {
  const s = await ReviewSuggestion.create(req.body);
  res.status(201).json(s);
}));

r.get("/review-suggestions", ah(async (_req, res) =>
  res.json(await ReviewSuggestion.find().populate("businessId").sort({ createdAt: -1 }))
));

// Returns each business that has at least one review, with counts by status.
r.get("/reviews/businesses", ah(async (_req, res) => {
  const agg = await ReviewSuggestion.aggregate([
    { $group: { _id: { businessId: "$businessId", status: "$status" }, count: { $sum: 1 } } },
    { $group: {
      _id: "$_id.businessId",
      total: { $sum: "$count" },
      byStatus: { $push: { status: "$_id.status", count: "$count" } },
    }},
    { $lookup: { from: "businesses", localField: "_id", foreignField: "_id", as: "biz" } },
    { $unwind: { path: "$biz", preserveNullAndEmpty: true } },
    { $project: {
      _id: 1,
      name: "$biz.name",
      email: "$biz.email",
      status: "$biz.status",
      total: 1,
      byStatus: 1,
    }},
    { $sort: { total: -1 } },
  ]);
  // flatten byStatus array into named keys for easy consumption
  const result = agg.map(({ byStatus, ...rest }) => ({
    ...rest,
    unused:   byStatus.find((s) => s.status === "unused")?.count  || 0,
    reserved: byStatus.find((s) => s.status === "reserved")?.count || 0,
    used:     byStatus.find((s) => s.status === "used")?.count     || 0,
  }));
  res.json(result);
}));

// Paginated reviews for a specific business.
r.get("/reviews", ah(async (req, res) => {
  const { businessId, status, page = "1", limit = "25" } = req.query;
  if (!businessId) return res.status(400).json({ error: "businessId required" });
  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const q = { businessId };
  if (status) q.status = status;
  const [total, data] = await Promise.all([
    ReviewSuggestion.countDocuments(q),
    ReviewSuggestion.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
  ]);
  res.json({ data, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
}));

r.post("/review-suggestions/bulk", ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Provide a non-empty items array" });
  }

  const docs = items
    .filter((it) => it && it.businessId && String(it.reviewText || "").trim())
    .map((it) => ({ businessId: it.businessId, reviewText: String(it.reviewText).trim() }));
  const skipped = items.length - docs.length;
  if (!docs.length) {
    return res.status(400).json({ error: "No valid items — each entry needs a businessId and reviewText" });
  }

  try {
    const created = await ReviewSuggestion.insertMany(docs, { ordered: false });
    res.status(201).json({ created: created.length, skipped });
  } catch (err) {
    // ordered:false still writes the valid docs even when some fail — report the split
    // instead of failing the whole batch (e.g. a typo'd businessId in row 4 of 20).
    const created = err.insertedDocs?.length ?? err.result?.result?.nInserted ?? 0;
    res.status(created ? 207 : 400).json({
      created,
      skipped: skipped + (docs.length - created),
      error: "Some rows failed — check businessId is a valid, existing business id",
    });
  }
}));

r.get("/analytics", ah(async (req, res) => {
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
}));

r.get("/overview", ah(async (_req, res) => {
  const [businesses, activeBusinesses, hardware, events] = await Promise.all([
    Business.countDocuments(),
    Business.countDocuments({ status: "active" }),
    Hardware.countDocuments(),
    AnalyticsEvent.countDocuments(),
  ]);
  res.json({ businesses, activeBusinesses, hardware, events });
}));

export default r;
