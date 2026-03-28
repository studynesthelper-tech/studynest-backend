import "dotenv/config";
import express from "express";
import cors from "cors";
import { router as authRouter }  from "./routes/auth.js";
import { router as aiRouter }    from "./routes/ai.js";
import { router as userRouter }  from "./routes/user.js";
import premiumRoutes             from "./routes/premium.js";
import stripeWebhookRoutes       from "./routes/stripe-webhook.js";

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.WEBSITE_URL,
  process.env.APP_BASE_URL,
  process.env.ALLOWED_ORIGIN_CHROME,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.startsWith("chrome-extension://")) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// ── Stripe webhook MUST come before express.json() ───────────
// Stripe needs the raw body for signature verification.
app.use(stripeWebhookRoutes);

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));

// ── Health / root ────────────────────────────────────────────
app.get("/", (_req, res) => res.send("StudyNest server is live 🚀"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), service: "studynest-server" }));

// ── Routes ───────────────────────────────────────────────────
app.use("/auth",    authRouter);     // POST /auth/register, /auth/login, /auth/refresh
app.use("/ai",      aiRouter);       // POST /ai/chat (streaming SSE, quota enforced)
app.use("/user",    userRouter);     // GET  /user/me
app.use("/premium", premiumRoutes);  // GET  /premium/status
                                     // POST /premium/checkout
                                     // POST /premium/checkout/confirm
                                     // POST /premium/portal

// ── Debug logs ───────────────────────────────────────────────
console.log("STRIPE_SECRET_KEY:", process.env.STRIPE_SECRET_KEY ? "Loaded" : "Missing");

app.listen(PORT, () => console.log(`StudyNest server running on port ${PORT}`));
