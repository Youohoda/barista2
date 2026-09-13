// Admin Dashboard — every number here comes from a real collection already written
// by real requests (ProviderStat from every providerChat call, Order from real
// webhook-confirmed payments, RequestLog from withLogging-wrapped routes, etc).
// Nothing is estimated or hardcoded. Kept as a separate file from api/owner.js
// (which already existed and is left untouched) so this can't accidentally change
// the existing owner-tools behavior; both use the same BARISTA_OWNER_EMAIL check.
import { db, User, Order, ProviderStat, AutomationRun, RequestLog, json, withLogging } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS } from './_plans.js';

const OWNER_EMAIL = (process.env.BARISTA_OWNER_EMAIL || '').trim().toLowerCase();

async function handlerImpl(req, res) {
  try {
    if (!OWNER_EMAIL) return json(res, 503, { error: 'BARISTA_OWNER_EMAIL غير مضبوط.' });
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    if (actor.email !== OWNER_EMAIL) return json(res, 403, { error: 'OWNER_ONLY' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    await db();

    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const [totalUsers, activeUsers24h, usersByPlanRaw, providerStats, paidOrders, failedOrders24h, autoFail24h, reqLast24h, errLast24h] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ updatedAt: { $gte: since24h } }),
      User.aggregate([{ $group: { _id: '$plan', count: { $sum: 1 } } }]),
      ProviderStat.find().lean(),
      Order.find({ status: 'paid', paidAt: { $gte: since7d } }).select('amount currency plan paidAt').lean(),
      Order.countDocuments({ status: 'failed', createdAt: { $gte: since24h } }),
      AutomationRun.countDocuments({ status: 'error', createdAt: { $gte: since24h } }),
      RequestLog.countDocuments({ createdAt: { $gte: since24h } }),
      RequestLog.countDocuments({ createdAt: { $gte: since24h }, status: { $gte: 500 } })
    ]);

    // Revenue is grouped by currency rather than summed together — EGP and USD are
    // not fungible, and silently adding them would be a fabricated number.
    const revenueByCurrency = {};
    for (const o of paidOrders) revenueByCurrency[o.currency] = (revenueByCurrency[o.currency] || 0) + o.amount;

    const usersByPlan = {};
    for (const row of usersByPlanRaw) usersByPlan[row._id || 'free'] = row.count;

    return json(res, 200, {
      users: { total: totalUsers, active24h: activeUsers24h, byPlan: usersByPlan },
      subscriptions: { plans: Object.keys(PLANS) },
      revenue7d: revenueByCurrency,
      failedOrders24h,
      providers: providerStats.map(p => ({
        provider: p.provider, model: p.model, success: p.success, failure: p.failure,
        avgLatencyMs: p.success + p.failure ? Math.round(p.totalLatencyMs / (p.success + p.failure)) : null
      })),
      automationFailures24h: autoFail24h,
      requests24h: reqLast24h,
      serverErrors24h: errLast24h,
      note: reqLast24h === 0 ? 'مفيش requests مسجلة في RequestLog لسه — دي بيانات جديدة، تتراكم بس من اللحظة اللي المسارات المعدّلة بـ withLogging بدأت تشتغل.' : undefined
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'تعذر فتح Admin Dashboard' });
  }
}

export default withLogging('/api/admin', handlerImpl);
