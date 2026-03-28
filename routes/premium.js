import { Router } from "express";
import Stripe from "stripe";
import { requireAuth } from "../middleware/auth.js";
import { syncStripePremium } from "../db/users.js";

const router = Router();

// ✅ Safe Stripe init
let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("Missing STRIPE_SECRET_KEY");
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// ✅ Config check
function checkConfig() {
  const missing = [];
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_PRICE_ID) missing.push("STRIPE_PRICE_ID");
  return missing;
}

// ─────────────────────────────────────────
// GET /premium/status
// ─────────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    res.json({
      userId: user.id,
      isPremium: user.plan === "premium",
      status: user.stripeStatus || (user.plan === "premium" ? "active" : "inactive"),
      expiresAt: user.stripePeriodEnd || null,
      cancelAtPeriodEnd: Boolean(user.stripeCancelAtEnd),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get status" });
  }
});

// ─────────────────────────────────────────
// POST /premium/checkout
// ─────────────────────────────────────────
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // 🔍 DEBUG: log env vars and user info on every checkout attempt
    console.log("=== /premium/checkout called ===");
    console.log("User ID:", user?.id);
    console.log("User plan:", user?.plan);
    console.log("Existing stripeCustomerId:", user?.stripeCustomerId);
    console.log("STRIPE_SECRET_KEY set:", !!process.env.STRIPE_SECRET_KEY);
    console.log("STRIPE_PRICE_ID:", process.env.STRIPE_PRICE_ID);
    console.log("APP_BASE_URL:", process.env.APP_BASE_URL);

    const stripe = getStripe();

    // ✅ ALWAYS create a Stripe customer if none exists
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      console.log("✅ Created new Stripe customer:", customerId);
    }

    const baseUrl = process.env.APP_BASE_URL;
    if (!baseUrl) {
      console.error("❌ Missing APP_BASE_URL env var");
      return res.status(500).json({ error: "Missing APP_BASE_URL" });
    }

    if (!process.env.STRIPE_PRICE_ID) {
      console.error("❌ Missing STRIPE_PRICE_ID env var");
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: process.env.EXTENSION_SUCCESS_URL
        ? `${process.env.EXTENSION_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`
        : `${baseUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.EXTENSION_CANCEL_URL || baseUrl,
      metadata: { userId: user.id },
      subscription_data: {
        metadata: { userId: user.id },
      },
    });

    console.log("✅ Stripe session created:", session.id);
    console.log("✅ Checkout URL:", session.url);

    res.json({ url: session.url });

  } catch (err) {
    console.error("🔥 STRIPE CHECKOUT ERROR:", err.message);
    console.error(err);
    res.status(500).json({ error: err.message || "Stripe failed" });
  }
});

// ─────────────────────────────────────────
// POST /premium/portal
// ─────────────────────────────────────────
router.post("/portal", requireAuth, async (req, res) => {
  try {
    if (!req.user.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found" });
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: process.env.APP_BASE_URL || "https://studynest.app/account/billing",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("PORTAL ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to create portal session" });
  }
});

// ─────────────────────────────────────────
// POST /premium/checkout/confirm
// ─────────────────────────────────────────
router.post("/checkout/confirm", requireAuth, async (req, res) => {
  try {
    const sessionId = req.body?.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const subscription = session.subscription;

    if (!subscription || typeof subscription === "string") {
      return res.status(400).json({ error: "Subscription not ready" });
    }

    const user = await syncStripePremium(req.user.id, {
      customerId: session.customer?.toString(),
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });

    res.json({
      ok: true,
      isPremium: user?.plan === "premium",
      status: user?.stripeStatus || subscription.status,
    });
  } catch (err) {
    console.error("CONFIRM ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to confirm session" });
  }
});

export default router;
