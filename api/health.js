// Real monitoring, not decorative status dots: DB connectivity is actually tested,
// and provider numbers come from ProviderStat (written by every real providerChat
// call in _lib.js) — if no requests have run yet, providers show `null` stats
// rather than a fabricated "🟢 Operational".
import { db, json } from './_lib.js';
import { getProviderHealth } from './_router.js';

export default async function handler(req, res) {
  const out = { ok: true, name: process.env.BARISTA_NAME || 'Barista AI', version: '4.0.0', checkedAt: new Date().toISOString() };

  try {
    await db();
    out.database = { status: 'up' };
  } catch (e) {
    out.ok = false;
    out.database = { status: 'down', error: e.message };
  }

  try {
    out.providers = await getProviderHealth();
  } catch {
    out.providers = [];
  }

  out.webSearch = { configured: !!process.env.BRAVE_API_KEY };
  out.cronSecretConfigured = !!process.env.CRON_SECRET;

  return json(res, out.ok ? 200 : 503, out);
}
