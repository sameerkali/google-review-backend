import { Router } from "express";
import Business from "../models/Business.js";
import Hardware from "../models/Hardware.js";
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
  // Default new items to the end of the list instead of tying at the
  // schema default of 0 and colliding with whatever's already there.
  const last = await MenuItem.findOne({ businessId: req.businessId }).sort({ sortOrder: -1 }).select("sortOrder").lean();
  const sortOrder = (last?.sortOrder ?? -1) + 1;
  const m = await MenuItem.create({ businessId: req.businessId, name, category: req.body.category || undefined, price, sortOrder });
  res.status(201).json(m);
}));

r.patch("/me/menu-items/reorder", ah(async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    return res.status(400).json({ error: "orderedIds is required and must be a non-empty array" });
  }
  // Scoping each updateOne's filter by businessId naturally ignores any id
  // that doesn't belong to this business — it just matches nothing.
  const ops = orderedIds.map((id, index) => ({
    updateOne: { filter: { _id: id, businessId: req.businessId }, update: { $set: { sortOrder: index } } },
  }));
  await MenuItem.bulkWrite(ops);
  res.json({ ok: true });
}));

r.patch("/me/menu-items/:id", ah(async (req, res) => {
  const m = await MenuItem.findOneAndUpdate(
    { _id: req.params.id, businessId: req.businessId },
    req.body,
    { new: true, runValidators: true }
  );
  return m ? res.json(m) : res.status(404).json({ error: "not found" });
}));

r.delete("/me/menu-items/:id", ah(async (req, res) => {
  const deleted = await MenuItem.findOneAndDelete({ _id: req.params.id, businessId: req.businessId }).lean();
  return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
}));

// Analytics and growth suggestions now live under /business/dashboard/* —
// see routes/businessDashboard.js — sourced from feedbackSessions/dailyStats
// instead of the old scan/click event counts.

export default r;
