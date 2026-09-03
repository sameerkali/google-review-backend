import rateLimit from "express-rate-limit";

// Login endpoints — brute-force protection. Admin and business logins get
// separate instances (not one shared `authLimiter`) so a burst of failed
// attempts against one doesn't eat into the other's budget for the same IP.
const loginLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
};
export const adminAuthLimiter = rateLimit(loginLimiterOptions);
export const businessAuthLimiter = rateLimit(loginLimiterOptions);

// Internal cron trigger — not user-facing traffic, so a low ceiling is fine
// and keeps a leaked CRON_SECRET from being used to hammer the aggregation
// job in a tight loop.
export const cronLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

// Public, unauthenticated endpoints hit by QR/NFC scans.
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});
