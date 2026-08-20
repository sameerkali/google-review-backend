import { Router } from "express";
import crypto from "node:crypto";
import Hardware from "../models/Hardware.js";
import Business from "../models/Business.js";
import ReviewSuggestion from "../models/ReviewSuggestion.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import { ah } from "../utils/asyncHandler.js";

const r = Router();

const uaInfo = (req) => {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const device = /mobile|android|iphone/i.test(ua) ? "mobile" : /ipad|tablet/i.test(ua) ? "tablet" : "desktop";
  const browser = /edg/.test(ua) ? "edge" : /chrome/.test(ua) ? "chrome" : /firefox/.test(ua) ? "firefox" : /safari/.test(ua) ? "safari" : "other";
  const os = /windows/.test(ua) ? "windows" : /android/.test(ua) ? "android" : /iphone|ipad/.test(ua) ? "ios" : /mac/.test(ua) ? "macos" : /linux/.test(ua) ? "linux" : "other";
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  return { device, browser, os, ipHash: crypto.createHash("sha256").update(ip).digest("hex") };
};

r.get("/r/:code", ah(async (req, res) => {
  const h = await Hardware.findOne({ serial: req.params.code }).populate("assignedBusinessId");
  if (!h || !h.assignedBusinessId) return res.status(404).json({ error: "invalid code" });
  const b = h.assignedBusinessId;

  // Reserve up to 3 unused suggestions at once
  const suggestions = await ReviewSuggestion.find({ businessId: b._id, status: "unused" }).limit(3);
  const now = new Date();
  await Promise.all(
    suggestions.map((s) => {
      s.status = "reserved";
      s.reservedAt = now;
      return s.save();
    })
  );

  res.json({
    business: { name: b.name, logoUrl: b.logoUrl, googleReviewUrl: b.googleReviewUrl },
    suggestions: suggestions.map((s) => ({ id: s._id, text: s.reviewText })),
    hardware: { code: h.serial },
  });
}));


const event = (eventType) => ah(async (req, res) => {
  const h = await Hardware.findOne({ serial: req.body.code });
  const b = h ? await Business.findById(h.assignedBusinessId) : null;
  if (!b) return res.status(404).json({ error: "unknown code" });
  await AnalyticsEvent.create({
    businessId: b._id,
    hardwareId: h?._id,
    code: req.body.code,
    eventType,
    ...uaInfo(req),
  });
  res.json({ ok: true });
});

r.post("/analytics", event("scan"));
r.post("/copy", event("review_copy"));
r.post("/open-google", event("google_click"));

export default r;