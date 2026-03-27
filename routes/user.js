// routes/user.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getUsageInfo } from "../db/users.js";

export const router = Router();

// ── GET /user/me ─────────────────────────────────────────────
router.get("/me", requireAuth, (req, res) => {
  const usage = getUsageInfo(req.user);
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    usage,
  });
});

