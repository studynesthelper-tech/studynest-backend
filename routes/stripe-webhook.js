// routes/stripe-webhook.js
import express, { Router } from "express";
import Stripe from "stripe";
import { syncStripePremium, findById, updateUser } from "../db/users.js";

const router = Router();

let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
  return _stripe;
}

function extractUserId(eventObject) {
  return (
    eventObject?.metadata?.userId ||
    eventObject?.client_reference_id ||
    null
  );
}

router.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const missing = [];
  if (!process.env.STRIPE_SECRET_KEY)     missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  if (missing.length) return res.status(500).send(`Missing config: ${missing.join(", ")}`);

  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).send("Missing stripe-signature header");

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId  = extractUserId(session);
        if (userId) {
          syncStripePremium(userId, {
            customerId:       session.customer ? String(session.customer) : null,
            subscriptionId:   session.subscription ? String(session.subscription) : null,
            status:           "active",
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
          });
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub    = event.data.object;
        const userId = extractUserId(sub);
        if (userId) {
          syncStripePremium(userId, {
            customerId:       sub.customer ? String(sub.customer) : null,
            subscriptionId:   sub.id,
            status:           sub.status || "inactive",
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const userId = extractUserId(sub);
        if (userId) {
          syncStripePremium(userId, {
            customerId:       sub.customer ? String(sub.customer) : null,
            subscriptionId:   sub.id,
            status:           "canceled",
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            cancelAtPeriodEnd: true,
          });
        }
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).send(error?.message || "Webhook processing failed");
  }
});

export default router;
