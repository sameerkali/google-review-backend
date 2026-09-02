import { Router } from "express";
import mongoose from "mongoose";
import Business from "../models/Business.js";
import Plan from "../models/Plan.js";
import Hardware from "../models/Hardware.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import MenuItem from "../models/MenuItem.js";
import { adminAuth, signAdmin } from "../middleware/auth.js";
import { hashPassword, safeEqual } from "../utils/password.js";
import { ah } from "../utils/asyncHandler.js";
import { authLimiter } from "../middleware/rateLimit.js";

const r = Router();

// Escapes regex metacharacters so a search string is matched literally.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

r.post("/login", authLimiter, (req, res) => {
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin";
  const ok = safeEqual(req.body.username, adminUser) && safeEqual(req.body.password, adminPass);
  return ok
    ? res.json({ token: signAdmin() })
    : res.status(401).json({ error: "invalid username or password" });
});

r.use(adminAuth);

r.post("/business", ah(async (req, res) => {
  const { serial, password, ...body } = req.body;
  const serials = (Array.isArray(serial) ? serial : serial ? [serial] : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (password) body.passwordHash = hashPassword(password);

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

  // .create() returns the full document regardless of the schema's `select: false`
  // on passwordHash (that only affects queries) — strip it before it goes out.
  const obj = b.toObject();
  delete obj.passwordHash;
  res.status(201).json({ ...obj, hardwareAssigned, hardwareCreated });
}));

r.put("/business/:id", ah(async (req, res) => {
  const { password, ...body } = req.body;
  if (password) body.passwordHash = hashPassword(password);
  const b = await Business.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
  if (!b) return res.status(404).json({ error: "not found" });
  const obj = b.toObject();
  delete obj.passwordHash;
  res.json(obj);
}));

r.get("/business", ah(async (req, res) => {
  const { page, limit = "25", search } = req.query;
  const q = search
    ? { $or: ["name", "email", "phone"].map((f) => ({ [f]: new RegExp(escapeRegex(search), "i") })) }
    : {};

  // No `page` → full list, unfiltered (used to bootstrap dropdowns elsewhere in the admin panel).
  if (!page) {
    const list = await Business.find().populate("planId").sort({ createdAt: -1 }).lean();
    return res.json(list);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [total, data] = await Promise.all([
    Business.countDocuments(q),
    Business.find(q).populate("planId").sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
  ]);
  res.json({ data, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
}));

r.delete("/business/:id", ah(async (req, res) => {
  await Business.findByIdAndDelete(req.params.id);
  // Free up any hardware that was pointing at this business — otherwise it's
  // left showing "assigned" against a business that no longer exists.
  await Hardware.updateMany(
    { assignedBusinessId: req.params.id },
    { assignedBusinessId: null, status: "available" }
  );
  // The menu is meaningless without its business — remove it with them
  // (matches the "menu will be permanently removed" warning shown in the admin UI).
  await MenuItem.deleteMany({ businessId: req.params.id });
  res.json({ ok: true });
}));

r.post("/hardware", ah(async (req, res) => {
  const items = req.body.items || [req.body];
  const created = await Hardware.insertMany(items);
  res.status(201).json(created);
}));

r.get("/hardware", ah(async (req, res) => {
  const { page, limit = "25", search } = req.query;
  const q = search
    ? { $or: ["serial", "type"].map((f) => ({ [f]: new RegExp(escapeRegex(search), "i") })) }
    : {};

  // No `page` → full list, unfiltered (used to bootstrap dropdowns elsewhere in the admin panel).
  if (!page) {
    const list = await Hardware.find().populate("assignedBusinessId").sort({ createdAt: -1 }).lean();
    return res.json(list);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [total, data] = await Promise.all([
    Hardware.countDocuments(q),
    Hardware.find(q).populate("assignedBusinessId").sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
  ]);
  res.json({ data, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
}));

r.put("/hardware/:id", ah(async (req, res) => {
  const h = await Hardware.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    .populate("assignedBusinessId")
    .lean();
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

r.delete("/plans/:id", ah(async (req, res) => {
  await Plan.findByIdAndDelete(req.params.id);
  // Free up any business that was on this plan — otherwise it's left pointing
  // at a plan that no longer exists.
  await Business.updateMany({ planId: req.params.id }, { planId: null });
  res.json({ ok: true });
}));

r.post("/menu-items", ah(async (req, res) => {
  const m = await MenuItem.create(req.body);
  res.status(201).json(m);
}));

r.put("/menu-items/:id", ah(async (req, res) => {
  const m = await MenuItem.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  return m ? res.json(m) : res.status(404).json({ error: "not found" });
}));

r.delete("/menu-items/:id", ah(async (req, res) => {
  await MenuItem.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

// Returns each business that has at least one menu item, with active/total counts.
r.get("/menu-items/businesses", ah(async (_req, res) => {
  const agg = await MenuItem.aggregate([
    { $group: {
      _id: "$businessId",
      total: { $sum: 1 },
      active: { $sum: { $cond: ["$active", 1, 0] } },
    }},
    { $lookup: { from: "businesses", localField: "_id", foreignField: "_id", as: "biz" } },
    { $unwind: { path: "$biz", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, name: "$biz.name", email: "$biz.email", status: "$biz.status", total: 1, active: 1 } },
    { $sort: { total: -1 } },
  ]);
  res.json(agg);
}));

// Full menu for a specific business (no pagination — a menu is a short list).
r.get("/menu-items", ah(async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: "businessId required" });
  const items = await MenuItem.find({ businessId }).sort({ sortOrder: 1, name: 1 }).lean();
  res.json(items);
}));

r.post("/menu-items/bulk", ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Provide a non-empty items array" });
  }

  // `id` is accepted and ignored if present (a JSON export's own id, not
  // ours — Mongo assigns its own _id on insert).
  const docs = items
    .filter((it) => it && it.businessId && String(it.name || "").trim())
    .map((it) => ({
      businessId: it.businessId,
      name: String(it.name).trim(),
      category: it.category || undefined,
      price: it.price !== undefined && it.price !== null && !isNaN(Number(it.price)) ? Number(it.price) : undefined,
    }));
  const skipped = items.length - docs.length;
  if (!docs.length) {
    return res.status(400).json({ error: "No valid items — each entry needs a businessId and name" });
  }

  try {
    const created = await MenuItem.insertMany(docs, { ordered: false });
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
  const { businessId, page, limit = "50", sort = "desc" } = req.query;
  const q = {};
  if (businessId) {
    // .aggregate() doesn't auto-cast query values the way .find()/.countDocuments()
    // do, so replicate the same CastError the rest of the API returns on a bad id.
    if (!mongoose.isValidObjectId(businessId)) {
      const err = new Error(`Cast to ObjectId failed for value "${businessId}" at path "businessId"`);
      err.name = "CastError";
      err.path = "businessId";
      throw err;
    }
    q.businessId = new mongoose.Types.ObjectId(businessId);
  }
  const sortDir = sort === "asc" ? 1 : -1;

  // Single grouped aggregation instead of 4 separate countDocuments round trips.
  const counts = await AnalyticsEvent.aggregate([
    { $match: q },
    { $group: { _id: "$eventType", count: { $sum: 1 } } },
  ]);
  const byType = { scan: 0, google_click: 0, review_copy: 0 };
  let total = 0;
  for (const c of counts) {
    if (c._id in byType) byType[c._id] = c.count;
    total += c.count;
  }
  const summary = { total, byType };

  // No `page` → old capped-list shape, kept for any caller that doesn't paginate.
  if (!page) {
    const rows = await AnalyticsEvent.find(q).sort({ createdAt: sortDir }).limit(500).lean();
    return res.json({ summary, rows });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const data = await AnalyticsEvent.find(q)
    .populate("businessId")
    .sort({ createdAt: sortDir })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum)
    .lean();
  res.json({ summary, data, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
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
