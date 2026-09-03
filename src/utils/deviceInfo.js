import crypto from "node:crypto";

// Shared by every route that records an AnalyticsEvent or a FeedbackSession's
// device snapshot from a raw request — kept in one place so scan, copy, and
// click all classify the same user-agent the same way.
export function uaInfo(req) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const device = /mobile|android|iphone/i.test(ua) ? "mobile" : /ipad|tablet/i.test(ua) ? "tablet" : "desktop";
  const browser = /edg/.test(ua) ? "edge" : /chrome/.test(ua) ? "chrome" : /firefox/.test(ua) ? "firefox" : /safari/.test(ua) ? "safari" : "other";
  const os = /windows/.test(ua) ? "windows" : /android/.test(ua) ? "android" : /iphone|ipad/.test(ua) ? "ios" : /mac/.test(ua) ? "macos" : /linux/.test(ua) ? "linux" : "other";
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  // Keyed HMAC, not a bare hash — the IPv4 space is only ~4.3 billion
  // addresses, so an unsalted SHA-256(ip) is a rainbow-table-in-minutes
  // problem and isn't real anonymization. Reusing JWT_SECRET as the HMAC key
  // avoids introducing a second secret to provision (server.js already
  // requires it to be set).
  const ipHash = crypto.createHmac("sha256", process.env.JWT_SECRET).update(ip).digest("hex");
  return { device, browser, os, ipHash };
}
