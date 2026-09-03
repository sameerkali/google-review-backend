import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import Hardware from "../models/Hardware.js";
import Business from "../models/Business.js";
import MenuItem from "../models/MenuItem.js";
import FeedbackSession from "../models/FeedbackSession.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import { ah } from "../utils/asyncHandler.js";
import { uaInfo } from "../utils/deviceInfo.js";
import { publicLimiter } from "../middleware/rateLimit.js";

const r = Router();
r.use(publicLimiter);

const SESSION_TTL_MS = 30 * 60 * 1000;

// Session creation gets its own, tighter limit on top of the general public
// one, keyed by the scanned code itself — without this, replaying the same
// QR's scan request in a loop can inflate one business's numbers even though
// each request comes from a different visitor/IP.
// NOTE: express-rate-limit's default store is in-process memory. That's fine
// for a single instance; on a multi-instance/serverless deployment each
// instance keeps its own counter, so this is a soft cap, not a hard one.
// The plan calls for a shared Redis-backed limiter once real scale (and
// Redis infra) exists — this is the same policy without that dependency yet.
const perCodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.body?.code || "unknown-code"),
  message: { error: "Too many scans for this code, please slow down" },
});
const perIpSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

function isExpired(session) {
  return Date.now() - new Date(session.startedAt).getTime() > SESSION_TTL_MS;
}

async function loadLiveSession(token) {
  const session = await FeedbackSession.findOne({ sessionToken: token });
  if (!session || isExpired(session)) return null;
  return session;
}

// POST /api/v1/feedback/session — scan a code, start a session, log it as a
// scan event (same AnalyticsEvent the admin/business dashboards already read).
r.post("/session", perIpSessionLimiter, perCodeLimiter, ah(async (req, res) => {
  const code = String(req.body.code || "").trim();
  if (!code) return res.status(400).json({ error: "code is required" });

  const hardware = await Hardware.findOne({ serial: code }).lean();
  if (!hardware || !hardware.assignedBusinessId) return res.status(404).json({ error: "invalid code" });

  const info = uaInfo(req);
  const sessionToken = crypto.randomBytes(18).toString("base64url"); // 24 chars

  await FeedbackSession.create({
    businessId: hardware.assignedBusinessId,
    qrCodeId: hardware._id,
    sessionToken,
    referrerType: hardware.type === "NFC" ? "nfc" : "qr",
    device: { os: info.os, browser: info.browser, isMobile: info.device === "mobile" },
  });

  await AnalyticsEvent.create({
    businessId: hardware.assignedBusinessId,
    hardwareId: hardware._id,
    code,
    eventType: "scan",
    ...info,
  });

  // Bundled in the same response (rather than a second round trip) — the
  // client needs the business identity for screen 1 and the Google URL for
  // the final tap, and both are already loaded here.
  const business = await Business.findById(hardware.assignedBusinessId)
    .select("name logoUrl googleReviewUrl")
    .lean();

  res.status(201).json({
    token: sessionToken,
    business: { name: business.name, logoUrl: business.logoUrl || null, googleReviewUrl: business.googleReviewUrl || null },
  });
}));

// GET /api/v1/feedback/:token/menu — menu chips for screen 1.
r.get("/:token/menu", ah(async (req, res) => {
  const session = await loadLiveSession(req.params.token);
  if (!session) return res.status(410).json({ error: "This session has expired — please scan the code again" });

  const items = await MenuItem.find({ businessId: session.businessId, active: true })
    .sort({ sortOrder: 1, name: 1 })
    .select("name category price")
    .lean();
  res.json(items.map((i) => ({ id: i._id, name: i.name, category: i.category || null, price: i.price ?? null })));
}));

// PATCH /api/v1/feedback/:token — save answers, idempotent per screen. Every
// field is optional so each screen can PATCH just what it collected.
r.patch("/:token", ah(async (req, res) => {
  const session = await loadLiveSession(req.params.token);
  if (!session) return res.status(410).json({ error: "This session has expired — please scan the code again" });

  const { rating, menuItemIds, freeTextItem, aspects } = req.body;
  const set = {};
  // updateOne() doesn't run schema validators (min/max) unless told to —
  // the schema's rating: {min:1, max:5} would otherwise be silently skipped
  // and let a bad value (999, a string, etc) land straight in the document.
  if (rating !== undefined) {
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ error: "rating must be an integer from 1 to 5" });
    }
    set.rating = r;
  }
  if (menuItemIds !== undefined) {
    if (!Array.isArray(menuItemIds)) return res.status(400).json({ error: "menuItemIds must be an array" });
    set.menuItemIds = menuItemIds;
  }
  if (freeTextItem !== undefined) set.freeTextItem = String(freeTextItem).slice(0, 120);
  if (aspects !== undefined) {
    if (!Array.isArray(aspects)) return res.status(400).json({ error: "aspects must be an array" });
    set.aspects = aspects;
  }

  await FeedbackSession.updateOne({ _id: session._id }, { $set: set }, { runValidators: true });
  res.json({ ok: true });
}));

// POST /api/v1/feedback/:token/draft — record the draft the client's pure
// buildDraft() produced. Generation itself happens entirely client-side
// (no model, no API round trip for the text) — this just persists what was
// shown, for funnel/quality tracking.
r.post("/:token/draft", ah(async (req, res) => {
  const session = await loadLiveSession(req.params.token);
  if (!session) return res.status(410).json({ error: "This session has expired — please scan the code again" });

  const draftGenerated = String(req.body.draftGenerated || "").slice(0, 500);
  await FeedbackSession.updateOne(
    { _id: session._id },
    { $set: { draftGenerated, completedAt: new Date() } }
  );
  res.json({ ok: true });
}));

// POST /api/v1/feedback/:token/copied — mark copied. Deliberately takes only
// `edited` + `length`, never the actual final text (see FeedbackSession).
r.post("/:token/copied", ah(async (req, res) => {
  const session = await loadLiveSession(req.params.token);
  if (!session) return res.status(410).json({ error: "This session has expired — please scan the code again" });

  const edited = Boolean(req.body.edited);
  const length = Number.isFinite(req.body.length) ? Math.max(0, Math.floor(req.body.length)) : undefined;
  await FeedbackSession.updateOne(
    { _id: session._id },
    { $set: { copiedAt: new Date(), draftEdited: edited, ...(length !== undefined ? { finalLength: length } : {}) } }
  );

  await AnalyticsEvent.create({
    businessId: session.businessId,
    hardwareId: session.qrCodeId,
    eventType: "review_copy",
    ...uaInfo(req),
  });

  res.json({ ok: true });
}));

// POST /api/v1/feedback/:token/clicked — mark the Google hand-off and hand
// back the URL to open (kept server-side so the client never has to fetch
// the business separately just to get this one field).
r.post("/:token/clicked", ah(async (req, res) => {
  const session = await loadLiveSession(req.params.token);
  if (!session) return res.status(410).json({ error: "This session has expired — please scan the code again" });

  const business = await Business.findById(session.businessId).select("googleReviewUrl").lean();
  if (!business?.googleReviewUrl) return res.status(422).json({ error: "No Google Review URL has been set for this business" });

  await FeedbackSession.updateOne({ _id: session._id }, { $set: { googleClickedAt: new Date() } });
  await AnalyticsEvent.create({
    businessId: session.businessId,
    hardwareId: session.qrCodeId,
    eventType: "google_click",
    ...uaInfo(req),
  });

  res.json({ googleUrl: business.googleReviewUrl });
}));

export default r;
