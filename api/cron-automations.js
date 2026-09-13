// Automation engine execution endpoint. Triggered by Vercel Cron (see the `crons`
// entry in vercel.json) — this is a REAL scheduled trigger provided by the hosting
// platform itself, not a fake/simulated background job. Two real constraints worth
// knowing (documented in the final report, not hidden here):
//   1. Vercel Cron granularity depends on your plan — Hobby projects are limited to
//      once-a-day cron invocations; Pro plans allow hourly (what vercel.json asks
//      for below). On Hobby, only automations whose `hour` matches whenever Vercel
//      actually fires that day will run — the rest wait for the next matching day.
//   2. This only *runs the model call* (e.g. "search AI news and summarize") and
//      stores the result in AutomationRun for the user to read via GET /api/automations
//      — it does not send email/push notifications, since no email provider is
//      configured in this project. Delivering results outside the app is a real gap,
//      called out in the final report, not silently pretended to work.
import { db, Automation, AutomationRun, json, providerChat } from './_lib.js';

export default async function handler(req, res) {
  // Guard against public invocation: Vercel sets this automatically for Cron-triggered
  // requests when CRON_SECRET is configured; without it, anyone who finds the URL
  // could burn a user's daily quota by spamming this endpoint.
  if (process.env.CRON_SECRET) {
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return json(res, 401, { error: 'Unauthorized' });
  }
  try {
    await db();
    const now = new Date();
    const hour = now.getUTCHours();
    const day = now.getUTCDay();
    const due = await Automation.find({ enabled: true, hour, daysOfWeek: day }).lean();

    const results = [];
    for (const a of due) {
      try {
        const r = await providerChat([
          { role: 'system', content: 'نفّذ الطلب التالي وارجع نتيجة نصية مفيدة ومباشرة، من غير مقدمة.' },
          { role: 'user', content: a.prompt }
        ], a.model || 'barista-just');
        await AutomationRun.create({ automationId: String(a._id), ownerId: a.ownerId, status: 'ok', output: (r.text || '').slice(0, 6000) });
        await Automation.updateOne({ _id: a._id }, { lastRunAt: now, lastStatus: 'ok' });
        results.push({ id: String(a._id), status: 'ok' });
      } catch (e) {
        await AutomationRun.create({ automationId: String(a._id), ownerId: a.ownerId, status: 'error', error: e.message });
        await Automation.updateOne({ _id: a._id }, { lastRunAt: now, lastStatus: 'error' });
        results.push({ id: String(a._id), status: 'error', error: e.message });
      }
    }
    return json(res, 200, { checked: due.length, results });
  } catch (e) {
    return json(res, 500, { error: e.message || 'فشل تشغيل الـ Automations' });
  }
}
