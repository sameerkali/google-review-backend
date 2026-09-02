import { Router } from "express";
import mongoose from "mongoose";
import Business from "../models/Business.js";
import Hardware from "../models/Hardware.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import MenuItem from "../models/MenuItem.js";
import { businessAuth, signBusiness } from "../middleware/auth.js";
import { verifyPassword } from "../utils/password.js";
import { ah } from "../utils/asyncHandler.js";
import { authLimiter } from "../middleware/rateLimit.js";

const r = Router();

r.post("/login", authLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  const business = await Business.findOne({ email }).select("+passwordHash").lean();
  if (!business || !verifyPassword(password, business.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (business.status !== "active") {
    return res.status(403).json({ error: `This account is ${business.status}. Contact your platform admin.` });
  }
  res.json({ token: signBusiness(business._id.toString()), businessName: business.name });
}));

r.use(businessAuth);

r.get("/me", ah(async (req, res) => {
  const business = await Business.findById(req.businessId).populate("planId").lean();
  if (!business) return res.status(404).json({ error: "not found" });
  res.json(business);
}));

r.get("/me/qr", ah(async (req, res) => {
  const hardware = await Hardware.find({ assignedBusinessId: req.businessId, status: "assigned" }).lean();
  res.json(hardware.map((h) => ({ serial: h.serial, type: h.type })));
}));

r.get("/me/menu-items", ah(async (req, res) => {
  res.json(await MenuItem.find({ businessId: req.businessId }).sort({ sortOrder: 1, name: 1 }).lean());
}));

r.post("/me/menu-items", ah(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const price = req.body.price !== undefined && req.body.price !== null && !isNaN(Number(req.body.price)) ? Number(req.body.price) : undefined;
  const m = await MenuItem.create({ businessId: req.businessId, name, category: req.body.category || undefined, price });
  res.status(201).json(m);
}));

r.delete("/me/menu-items/:id", ah(async (req, res) => {
  const deleted = await MenuItem.findOneAndDelete({ _id: req.params.id, businessId: req.businessId }).lean();
  return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
}));

r.get("/me/analytics", ah(async (req, res) => {
  const business = await Business.findById(req.businessId).populate("planId").lean();
  const features = business?.planId?.features || { analytics: "none", userData: false };
  if (features.analytics === "none") {
    return res.status(403).json({ error: "Your plan doesn't include analytics — upgrade to see how your QR is performing." });
  }

  // .aggregate() doesn't auto-cast query values the way .find()/.countDocuments() do,
  // so the businessId must be cast to ObjectId explicitly for $match to hit the index.
  const q = { businessId: new mongoose.Types.ObjectId(req.businessId) };
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
  const payload = {
    level: features.analytics,
    summary: { total, byType, conversionRate: byType.scan ? Math.round((byType.google_click / byType.scan) * 100) : 0 },
  };

  if (features.analytics === "full") {
    const byField = (field) => AnalyticsEvent.aggregate([{ $match: q }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
    const [device, browser, os] = await Promise.all([byField("device"), byField("browser"), byField("os")]);
    payload.breakdown = { device, browser, os };
  }

  if (features.userData) {
    payload.recentEvents = await AnalyticsEvent.find(q).sort({ createdAt: -1 }).limit(50).select("eventType device browser os createdAt").lean();
  }

  res.json(payload);
}));

r.get("/me/suggestions", ah(async (req, res) => {
  const business = await Business.findById(req.businessId).populate("planId").lean();
  if (!business?.planId?.features?.suggestions) {
    return res.status(403).json({ error: "Your plan doesn't include growth suggestions — upgrade to Pro to unlock this." });
  }

  const q = { businessId: new mongoose.Types.ObjectId(req.businessId) };
  // Single grouped aggregation for the two AnalyticsEvent counts instead of 2 round trips.
  const [eventCounts, menuItemCount, hardwareCount] = await Promise.all([
    AnalyticsEvent.aggregate([{ $match: q }, { $group: { _id: "$eventType", count: { $sum: 1 } } }]),
    MenuItem.countDocuments({ businessId: req.businessId, active: true }),
    Hardware.countDocuments({ assignedBusinessId: req.businessId }),
  ]);
  const byType = { scan: 0, google_click: 0 };
  for (const c of eventCounts) if (c._id in byType) byType[c._id] = c.count;
  const scans = byType.scan;
  const clicks = byType.google_click;

  // Simple rule-based tips from the business's own numbers — no ML, just
  // thresholds on data we already have, gated behind the Pro-only feature flag.
  const tips = [];
  if (scans === 0) tips.push("No scans yet — make sure your QR code or table tent is visible and well-lit near checkout.");
  if (scans > 0 && clicks / scans < 0.5) tips.push(`Only ${Math.round((clicks / scans) * 100)}% of scans lead to a Google review — try shortening the flow or moving the code somewhere more visible.`);
  if (menuItemCount < 5) tips.push(`You have ${menuItemCount} menu item${menuItemCount === 1 ? "" : "s"} listed — adding more gives customers a better chance of finding what they ordered.`);
  if (hardwareCount < 2) tips.push("You only have one QR/NFC code active — a second one (e.g. at the table and at checkout) catches more customers.");
  if (!tips.length) tips.push("You're doing well across the board — keep an eye on your conversion rate as scan volume grows.");

  res.json({ tips });
}));

export default r;
