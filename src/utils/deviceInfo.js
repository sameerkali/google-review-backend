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
  return { device, browser, os, ipHash: crypto.createHash("sha256").update(ip).digest("hex") };
}
