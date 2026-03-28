// routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { findByEmail, createUser, findById } from "../db/users.js";

export const router = Router();

// ✅ Ensure JWT_SECRET exists
if (!process.env.JWT_SECRET) {
  console.error("❌ FATAL: JWT_SECRET is missing");
  throw new Error("Missing JWT_SECRET");
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
const makeToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

const makeRefresh = (id) => {
  return jwt.sign(
    { id, type: "refresh" },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
};

// ─────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    console.log("👉 REGISTER HIT");

    const { email, password, name } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    if (findByEmail(email)) {
      return res.status(409).json({
        error: "Email already registered",
      });
    }

    const id = uuid();
    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();

    const user = createUser({
      id,
      email: email.toLowerCase(),
      name: name || email.split("@")[0],
      passwordHash,
      plan: "free",
      freeQuestions: 20,
      freeResetAt: now + 7 * 24 * 60 * 60 * 1000,
      totalQuestions: 0,
      createdAt: now,
    });

    const token = makeToken(id);
    const refreshToken = makeRefresh(id);

    res.json({
      token,
      refreshToken,
      user: {
        id,
        email: user.email,
        name: user.name,
        plan: user.plan,
      },
    });

  } catch (err) {
    console.error("🔥 REGISTER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    console.log("👉 LOGIN HIT");

    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required",
      });
    }

    const user = findByEmail(email);

    if (!user) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);

    if (!match) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const token = makeToken(user.id);
    const refreshToken = makeRefresh(user.id);

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
      },
    });

  } catch (err) {
    console.error("🔥 LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────
router.post("/refresh", (req, res) => {
  try {
    console.log("👉 REFRESH HIT");

    const { refreshToken } = req.body || {};

    if (!refreshToken) {
      return res.status(400).json({
        error: "No refresh token",
      });
    }

    const payload = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (payload.type !== "refresh") {
      return res.status(401).json({
        error: "Invalid refresh token",
      });
    }

    const user = findById(payload.id);

    if (!user) {
      return res.status(401).json({
        error: "User not found",
      });
    }

    const newToken = makeToken(user.id);

    res.json({ token: newToken });

  } catch (err) {
    console.error("🔥 REFRESH ERROR:", err);
    res.status(401).json({
      error: "Invalid or expired refresh token",
    });
  }
});
