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
      status:
        user.stripeStatus ||
        (user.plan === "premium" ? "active" : "inactive"),
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
    const missing = checkConfig();
    if (missing.length) {
      return res
        .status(500)
        .json({ error: `Missing config: ${missing.join(", ")}` });
    }

    const user = req.user;

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",

      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId
        ? undefined
        : user.email || undefined,

      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],

      success_url: `${
        process.env.EXTENSION_SUCCESS_URL ||
        process.env.APP_BASE_URL + "/upgrade/success"
      }?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        process.env.EXTENSION_CANCEL_URL ||
        process.env.APP_BASE_URL + "/upgrade/cancel",

      metadata: {
        userId: user.id,
      },

      subscription_data: {
        metadata: {
          userId: user.id,
        },
      },

      allow_promotion_codes: true,
    });

    return res.json({
      url: session.url,
      id: session.id,
    });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    return res.status(500).json({
      error: err.message || "Failed to create checkout session",
    });
  }
});

// ─────────────────────────────────────────
// POST /premium/portal
// ─────────────────────────────────────────
router.post("/portal", requireAuth, async (req, res) => {
  try {
    if (!req.user.stripeCustomerId) {
      return res.status(400).json({
        error: "No Stripe customer found",
      });
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url:
        process.env.APP_BASE_URL ||
        "https://studynest.app/account/billing",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("PORTAL ERROR:", err);
    res.status(500).json({
      error: err.message || "Failed to create portal session",
    });
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

    const session = await getStripe().checkout.sessions.retrieve(
      sessionId,
      {
        expand: ["subscription"],
      }
    );

    const subscription = session.subscription;

    if (!subscription || typeof subscription === "string") {
      return res.status(400).json({
        error: "Subscription not ready",
      });
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
    res.status(500).json({
      error: err.message || "Failed to confirm session",
    });
  }
});

export default router;
