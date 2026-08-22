import crypto from "node:crypto";

/* scrypt-based password hashing — no extra dependency (bcrypt) needed since
   Node's crypto module already provides a solid KDF for this. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Constant-time string comparison for the admin login's plain-env-var
// credentials, so a wrong guess can't be timed to learn how much it matched.
export function safeEqual(input, expected) {
  const a = Buffer.from(String(input ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // constant-time no-op — avoids a length-based timing signal
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
