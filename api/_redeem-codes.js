// Redeem codes are sensitive: whoever can read this file can grant themselves
// free premium. They load ONLY from the BARISTA_REDEEM_CODES environment
// variable (set it in Vercel → Project → Settings → Environment Variables) —
// there is intentionally NO hardcoded fallback list anymore. Earlier versions
// of this project shipped real working codes (including one, "y7", that
// granted free unlimited "God" plan forever) directly in this source file.
// Once a zip/repo containing that has been shared with anyone — including
// pasted into a chat, like this one — those codes must be treated as
// permanently compromised: rotate them, don't just keep them as a "fallback".
//
// Expected format for BARISTA_REDEEM_CODES (a single-line JSON string):
// {
//   "SOME-CODE": { "plan": "plus", "months": 1, "label": "Plus لمدة شهر" },
//   "OTHER-CODE": { "random": ["gpt","go"], "years": 1, "label": "..." },
//   "MASTER-CODE": { "plan": "god", "unlimited": true, "label": "..." }
// }
//
// If the env var is missing or invalid, redemption is simply disabled (empty
// code list) instead of silently falling back to old, possibly-leaked codes.

let cache = null;
export function getRedeemCodes() {
  if (cache) return cache;
  const raw = process.env.BARISTA_REDEEM_CODES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        cache = parsed;
        return cache;
      }
    } catch {
      console.warn('BARISTA_REDEEM_CODES موجود لكن مش JSON صالح — تفعيل الأكواد متوقف مؤقتًا لحد ما يتصلح.');
    }
  }
  cache = {};
  return cache;
}
