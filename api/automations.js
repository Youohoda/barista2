import mongoose from 'mongoose';
import { db, Automation, AutomationRun, json, body } from './_lib.js';
import { requireUser } from './auth.js';

export default async function handler(req, res) {
  try {
    const actor = await requireUser(req);
    await db();

    if (req.method === 'GET') {
      const items = await Automation.find({ ownerId: actor.id }).sort({ createdAt: -1 }).lean();
      const withRuns = await Promise.all(items.map(async a => ({
        id: String(a._id), prompt: a.prompt, model: a.model, hour: a.hour, daysOfWeek: a.daysOfWeek,
        enabled: a.enabled, lastRunAt: a.lastRunAt, lastStatus: a.lastStatus,
        runs: await AutomationRun.find({ automationId: String(a._id) }).sort({ createdAt: -1 }).limit(5).lean()
      })));
      return json(res, 200, { items: withRuns });
    }

    if (req.method === 'POST') {
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 1000);
      if (!prompt) return json(res, 400, { error: 'اكتب طلب الـ Automation' });
      const hour = Number.isInteger(b.hour) && b.hour >= 0 && b.hour <= 23 ? b.hour : 8;
      const daysOfWeek = Array.isArray(b.daysOfWeek) && b.daysOfWeek.length ? b.daysOfWeek.filter(d => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
      const model = ['barista-fast', 'barista-just', 'barista-code', 'barista-reasoning'].includes(b.model) ? b.model : 'barista-just';
      const doc = await Automation.create({ ownerId: actor.id, prompt, hour, daysOfWeek, model, enabled: true });
      return json(res, 200, { id: String(doc._id) });
    }

    if (req.method === 'PATCH') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      const b = await body(req);
      const update = {};
      if (typeof b.enabled === 'boolean') update.enabled = b.enabled;
      if (typeof b.prompt === 'string' && b.prompt.trim()) update.prompt = b.prompt.trim().slice(0, 1000);
      if (Number.isInteger(b.hour)) update.hour = Math.max(0, Math.min(23, b.hour));
      const doc = await Automation.findOneAndUpdate({ _id: id, ownerId: actor.id }, update, { new: true }).lean();
      if (!doc) return json(res, 404, { error: 'Automation غير موجود' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      await Automation.deleteOne({ _id: id, ownerId: actor.id });
      await AutomationRun.deleteMany({ automationId: id, ownerId: actor.id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في الـ Automations' });
  }
}
