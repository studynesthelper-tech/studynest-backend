// routes/premium.js
import { Router } from "express";
import Stripe from "stripe";
import { requireAuth } from "../middleware/auth.js";
import { syncStripePremium } from "../db/users.js";

const router = Router();

let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
  return _stripe;
}

function assertStripeConfig() {
  const missing = [];
  if (!process.env.STRIPE_SECRET_KEY)    missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_PRICE_ID)      missing.push("STRIPE_PRICE_ID");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  return missing;
}

function ensureConfigured(res) {
  const missing = assertStripeConfig();
  if (!missing.length) return false;
  res.status(500).json({ error: `Missing Stripe config: ${missing.join(", ")}` });
  return true;
}

// ── GET /premium/status ──────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  const user = req.user;
  res.json({
    userId:           user.id,
    isPremium:        user.plan === "premium",
    status:           user.stripeStatus || (user.plan === "premium" ? "active" : "inactive"),
    expiresAt:        user.stripePeriodEnd || null,
    cancelAtPeriodEnd: Boolean(user.stripeCancelAtEnd),
    source:           "stripe",
  });
});

// ── POST /premium/checkout ───────────────────────────────────
router.post("/checkout", requireAuth, async (req, res) => {
  if (ensureConfigured(res)) return;
  try {
    const user = req.user;
    const metadata = { userId: user.id, source: "studynest_extension" };

    const session = await stripe.checkout.sessions.create({
      mode:         "subscription",
      customer:     user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email || undefined,
      line_items:   [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url:  `${process.env.EXTENSION_SUCCESS_URL || process.env.APP_BASE_URL + "/upgrade/success"}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:   process.env.EXTENSION_CANCEL_URL || process.env.APP_BASE_URL + "/upgrade/cancel",
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, id: session.id });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to create checkout session" });
  }
});

// ── POST /premium/portal ─────────────────────────────────────
router.post("/portal", requireAuth, async (req, res) => {
  if (ensureConfigured(res)) return;
  try {
    const user = req.user;
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found for this user" });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${process.env.APP_BASE_URL || "https://studynest.app"}/account/billing`,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to create customer portal session" });
  }
});

// ── POST /premium/checkout/confirm ───────────────────────────
// Called by the extension after a successful checkout redirect
// to immediately sync the subscription into the user record.
router.post("/checkout/confirm", requireAuth, async (req, res) => {
  if (ensureConfigured(res)) return;
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
    const subscription = session.subscription;
    if (!subscription || typeof subscription === "string") {
      return res.status(400).json({ error: "Subscription not available yet" });
    }

    const user = syncStripePremium(req.user.id, {
      customerId:       session.customer ? String(session.customer) : null,
      subscriptionId:   subscription.id,
      status:           subscription.status,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });

    res.json({
      ok:        true,
      isPremium: user?.plan === "premium",
      status:    user?.stripeStatus || subscription.status,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to verify checkout session" });
  }
});

export default router;
