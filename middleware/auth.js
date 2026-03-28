// middleware/auth.js
import jwt from "jsonwebtoken";

export const requireAuth = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const userId = payload.id || payload.sub || payload.userId;

    if (!userId) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // ✅ DO NOT depend on DB for now
    req.user = {
      id: String(userId),
      email: payload.email || null,
      stripeCustomerId: null,
      plan: "free",
    };

    next();

  } catch (err) {
    console.error("🔥 AUTH ERROR:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
