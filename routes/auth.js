// routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { findByEmail, createUser, findById } from "../db/users.js";

export const router = Router();

const makeToken  = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const makeRefresh = (id) => jwt.sign({ id, type: "refresh" }, process.env.JWT_SECRET, { expiresIn: "30d" });

// ── POST /auth/register ──────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (findByEmail(email)) return res.status(409).json({ error: "Email already registered" });

    const id           = uuid();
    const passwordHash = await bcrypt.hash(password, 10);
    const now          = Date.now();

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

    res.json({
      token:        makeToken(id),
      refreshToken: makeRefresh(id),
      user: { id, email: user.email, name: user.name, plan: user.plan },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /auth/login ─────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = findByEmail(email);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

    res.json({
      token:        makeToken(user.id),
      refreshToken: makeRefresh(user.id),
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /auth/refresh ───────────────────────────────────────
router.post("/refresh", (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "No refresh token" });

    const payload = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid refresh token" });

    const user = findById(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });

    res.json({ token: makeToken(user.id) });
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

