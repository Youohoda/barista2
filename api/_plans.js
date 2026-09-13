// Single source of truth for plan limits, so chat.js / account.js / owner.js
// can never drift out of sync with each other (previously duplicated in 2 files).

// Prices are NOT decided in code — they're read from environment variables so
// setting/changing real prices never needs a code change or a redeploy of logic.
// The numbers after `||` are fallback defaults ONLY for local/dev when the env vars
// aren't set; they are the same placeholder figures earlier versions shipped with,
// kept only so `npm run dev` doesn't crash with NaN prices. Set these in Vercel
// before taking real payments — this file will never invent a "real" price for you:
//   PLAN_PRICE_GPT_EGP / PLAN_PRICE_GPT_USD
//   PLAN_PRICE_GO_EGP  / PLAN_PRICE_GO_USD
//   PLAN_PRICE_PLUS_EGP / PLAN_PRICE_PLUS_USD
function envPrice(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const PLANS = {
  free: { name: 'Free', daily: 25, maxFileMB: 5, level: 0 },
  gpt: { name: 'GPT', daily: 100, maxFileMB: 15, level: 1, priceEGP: envPrice('PLAN_PRICE_GPT_EGP', 99), priceUSD: envPrice('PLAN_PRICE_GPT_USD', 4.99) },
  go: { name: 'Go', daily: 300, maxFileMB: 30, level: 2, priceEGP: envPrice('PLAN_PRICE_GO_EGP', 199), priceUSD: envPrice('PLAN_PRICE_GO_USD', 8.99) },
  plus: { name: 'Plus', daily: 1000, maxFileMB: 80, level: 3, priceEGP: envPrice('PLAN_PRICE_PLUS_EGP', 349), priceUSD: envPrice('PLAN_PRICE_PLUS_USD', 14.99) },
  god: { name: 'God', daily: Infinity, maxFileMB: 250, level: 4 } // not purchasable — gift/redeem only
};

export const PLAN_IDS = ['gpt', 'go', 'plus', 'god'];

// Plans a user can actually buy through the payment system (God stays gift/redeem-only
// on purpose — selling literal "unlimited forever" for a fixed price is a bad idea).
export const PAYABLE_PLAN_IDS = ['gpt', 'go', 'plus'];

export const MODEL_WEIGHT = {
  'barista-fast': 1,
  'barista-just': 2,
  // Bumped 3→4: barista-code now runs a self-review pass on any reply containing code,
  // plus can make several workspace tool round-trips — it regularly costs 2-3x the model
  // calls of a plain barista-just message, so its quota weight should reflect that.
  'barista-code': 4,
  'barista-reasoning': 4,
  'barista-image': 3
};

// Returns the plan a user is actually entitled to *right now* (expired premium falls back to 'free').
export function activePlan(u) {
  if (u.plan === 'god' && u.unlimited) return 'god';
  if (u.premiumExpiresAt && new Date(u.premiumExpiresAt) > new Date()) return u.plan || 'free';
  return 'free';
}

// Resets the daily usage counter once a new calendar day starts.
// Mutates the passed-in user doc; caller is responsible for saving it.
export function resetIfNeeded(u) {
  const now = new Date();
  const last = new Date(u.dailyResetAt || 0);
  if (now.toDateString() !== last.toDateString()) {
    u.dailyUsed = 0;
    u.dailyResetAt = now;
  }
}
