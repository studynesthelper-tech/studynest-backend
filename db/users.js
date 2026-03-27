// db/users.js — simple JSON file store (swap for Postgres/MongoDB later)
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Quota config — change these in your .env ─────────────────
export const FREE_QUESTIONS_PER_WEEK = parseInt(process.env.FREE_QUESTIONS    || "20");
export const PREMIUM_QUESTIONS       = parseInt(process.env.PREMIUM_QUESTIONS  || "999");
export const RESET_DAYS              = parseInt(process.env.RESET_DAYS         || "7");
export const WEEK_MS                 = RESET_DAYS * 24 * 60 * 60 * 1000;

const __dir   = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, "users.json");

const load = () => {
  if (!existsSync(DB_PATH)) return {};
  try { return JSON.parse(readFileSync(DB_PATH, "utf8")); } catch { return {}; }
};
const save = (data) => writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

export const findByEmail = (email) => {
  const db = load();
  return Object.values(db).find(u => u.email === email.toLowerCase()) || null;
};
export const findById = (id) => load()[id] || null;

export const createUser = (user) => {
  const db = load();
  db[user.id] = user;
  save(db);
  return user;
};
export const updateUser = (id, patch) => {
  const db = load();
  if (!db[id]) return null;
  db[id] = { ...db[id], ...patch };
  save(db);
  return db[id];
};

export const getUsageInfo = (user) => {
  const now = Date.now();
  if (!user.freeResetAt || now > user.freeResetAt) {
    const quota = user.plan === "premium" ? PREMIUM_QUESTIONS : FREE_QUESTIONS_PER_WEEK;
    user = updateUser(user.id, {
      freeQuestions: quota,
      freeResetAt:   now + WEEK_MS,
    });
  }
  const isPremium   = user.plan === "premium";
  const remaining   = isPremium ? PREMIUM_QUESTIONS : (user.freeQuestions || 0);
  const resetIn     = Math.max(0, user.freeResetAt - Date.now());
  const resetInDays = Math.ceil(resetIn / (24 * 60 * 60 * 1000));

  return {
    plan:                     user.plan,
    is_premium:               isPremium,
    free_questions_remaining: remaining,
    total_questions:          user.totalQuestions || 0,
    reset_in_days:            resetInDays,
    reset_at:                 user.freeResetAt,
    email:                    user.email,
  };
};

// ── Stripe premium sync ──────────────────────────────────────
// Called by the Stripe webhook and checkout/confirm to keep
// the user record in sync with the Stripe subscription status.
export function syncStripePremium(userId, { customerId, subscriptionId, status, currentPeriodEnd, cancelAtPeriodEnd }) {
  const db = load();
  if (!db[userId]) return null;

  const isActive = ["active", "trialing"].includes(status);

  db[userId] = {
    ...db[userId],
    plan:              isActive ? "premium" : "free",
    stripeCustomerId:  customerId     || db[userId].stripeCustomerId  || null,
    stripeSubId:       subscriptionId || db[userId].stripeSubId       || null,
    stripeStatus:      status         || "inactive",
    stripePeriodEnd:   currentPeriodEnd || null,
    stripeCancelAtEnd: Boolean(cancelAtPeriodEnd),
    stripeUpdatedAt:   new Date().toISOString(),
  };

  // Immediately grant full quota when going premium
  if (isActive) {
    db[userId].freeQuestions = PREMIUM_QUESTIONS;
    db[userId].freeResetAt   = Date.now() + WEEK_MS;
  }

  save(db);
  return db[userId];
}
