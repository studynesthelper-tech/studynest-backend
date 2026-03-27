// middleware/auth.js
import jwt from "jsonwebtoken";
import { findById } from "../db/users.js";

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Support both JWT formats:
    //   Live backend:   { id: "..." }
    //   Cursor backend: { sub: "...", email: "...", name: "..." }
    const userId = payload.id || payload.sub || payload.userId;
    if (!userId) return res.status(401).json({ error: "Invalid token: no user id" });

    const user = findById(String(userId));
    if (!user) return res.status(401).json({ error: "User not found" });

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
