// middleware/auth.js
import jwt from "jsonwebtoken";
import { findById } from "../db/users.js";

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const userId = payload.id || payload.sub || payload.userId;
    if (!userId) {
      return res.status(401).json({ error: "Invalid token: no user id" });
    }

    const dbUser = findById(String(userId));

    req.user = dbUser || {
      id: String(userId),
      email: payload.email || null,
      name: payload.name || "User",
      plan: payload.plan || "free",
      freeQuestions: 20,
      totalQuestions: 0,
      stripeCustomerId: null,
      stripeSubId: null,
      stripeStatus: "inactive",
      stripePeriodEnd: null,
      stripeCancelAtEnd: false,
    };

    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
