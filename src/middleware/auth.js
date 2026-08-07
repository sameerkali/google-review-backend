import jwt from "jsonwebtoken";

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