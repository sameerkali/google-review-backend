import jwt from "jsonwebtoken";
import Business from "../models/Business.js";

export const adminAuth = (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
};

export const signAdmin = () =>
  jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });

// Re-checks the business's live status on every request rather than trusting
// only the JWT signature — a token is valid for 30 days, so without this an
// admin suspending or deleting a business wouldn't actually cut off access
// until the token happened to expire.
export const businessAuth = async (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "business" || !payload.businessId) throw new Error("wrong role");
    const business = await Business.findById(payload.businessId).select("status").lean();
    if (!business) return res.status(401).json({ error: "unauthorized" });
    if (business.status !== "active") {
      // `reason: "suspended"` distinguishes this from businessDashboard.js's
      // requireTier() 403 (reason: "tier") — both are a plain 403 on a
      // business-scoped route, and a frontend has no other reliable way to
      // tell "your account is suspended, log out" from "your plan doesn't
      // include this report" without it.
      return res.status(403).json({ reason: "suspended", status: business.status, error: `This account is ${business.status}. Contact your platform admin.` });
    }
    req.businessId = payload.businessId;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
};

export const signBusiness = (businessId) =>
  jwt.sign({ role: "business", businessId }, process.env.JWT_SECRET, { expiresIn: "30d" });