import { db, User, Gift, json, body } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS, activePlan, resetIfNeeded } from './_plans.js';

export default async function handler(req, res) {
  try {
    const actor = await requireUser(req);
    await db();
    let doc = await User.findOne({ clerkId: actor.id });
    if (!doc && actor.email) doc = await User.findOne({ email: actor.email.toLowerCase() });
    if (!doc) doc = await User.create({ clerkId: actor.id, email: actor.email, displayName: [actor.firstName, actor.lastName].filter(Boolean).join(' ') || actor.email });
    else { doc.clerkId = actor.id; doc.email = actor.email.toLowerCase(); }

    // Apply eligible owner-created gifts once per account.
    // Country for "gift by country" eligibility must come from Vercel's own edge-set
    // geo header, never from an arbitrary client header — a client can send any
    // `x-country: EG` value itself to fake being in a targeted country otherwise.
    const country = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const now = new Date();
    const gifts = await Gift.find({ active: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).limit(100).lean();
    const levels = { free: 0, gpt: 1, go: 2, plus: 3, god: 4 };
    for (const g of gifts) {
      const eligible = (g.target === 'all') || (g.target === 'user' && g.email === actor.email.toLowerCase()) || (g.target === 'country' && g.country === country);
      if (!eligible || (doc.giftClaims || []).includes(String(g._id))) continue;
      if (g.maxClaims > 0 && g.claims >= g.maxClaims) continue;
      let end = new Date(now);
      if (g.durationUnit === 'days') end.setDate(end.getDate() + g.durationValue);
      else if (g.durationUnit === 'weeks') end.setDate(end.getDate() + g.durationValue * 7);
      else if (g.durationUnit === 'months') end.setMonth(end.getMonth() + g.durationValue);
      else end.setFullYear(end.getFullYear() + g.durationValue);
      if (g.plan === 'god') {
        doc.plan = 'god'; doc.unlimited = false; doc.premiumExpiresAt = end;
      } else if (levels[g.plan] > levels[doc.plan || 'free'] || !doc.premiumExpiresAt || new Date(doc.premiumExpiresAt) < end) {
        doc.plan = g.plan; doc.unlimited = false; doc.premiumExpiresAt = end;
      }
      doc.giftClaims = doc.giftClaims || [];
      doc.giftClaims.push(String(g._id));
      await Gift.updateOne({ _id: g._id, active: true }, { $inc: { claims: 1 } });
    }

    // Keep the daily usage counter in sync even if the user only opens the
    // app and never sends a chat message on a new day (previously this only
    // happened inside chat.js, so the account screen could show yesterday's
    // stale "used" count until the first message of the day).
    resetIfNeeded(doc);

    if (req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'reset-usage') {
        doc.dailyUsed = 0; doc.dailyResetAt = new Date();
        await doc.save();
        return json(res, 200, { ok: true, dailyUsed: 0 });
      }
      await doc.save();
      return json(res, 400, { error: 'إجراء غير معروف' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    doc.email = actor.email;
    doc.displayName = [actor.firstName, actor.lastName].filter(Boolean).join(' ') || doc.displayName;
    doc.imageUrl = actor.imageUrl;
    await doc.save();

    const plan = activePlan(doc), p = PLANS[plan];
    return json(res, 200, {
      account: {
        id: doc.clerkId, email: doc.email, name: doc.displayName, imageUrl: doc.imageUrl, plan, planName: p.name,
        premiumExpiresAt: doc.unlimited ? null : doc.premiumExpiresAt, unlimited: !!doc.unlimited,
        dailyLimit: p.daily === Infinity ? null : p.daily, dailyUsed: doc.dailyUsed || 0, maxFileMB: p.maxFileMB,
        redeemedCount: doc.redeemedCodes?.length || 0
      }
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'تعذر تحميل الحساب' });
  }
}
