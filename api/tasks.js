// Tasks / Todo System — real rows in Mongo, scoped to {ownerId, projectId} exactly
// like every other collection in this project. The agent (see _tools.js) writes to
// the same collection via create_task/update_task, so a plan the agent produces and
// the checklist the user edits by hand are one system, not two.
import mongoose from 'mongoose';
import { db, Task, json, body, logActivity, withLogging } from './_lib.js';
import { requireUser } from './auth.js';

function serialize(t) {
  return {
    id: String(t._id), title: t.title, done: !!t.done, priority: t.priority,
    dueDate: t.dueDate || null, order: t.order, chatId: t.chatId || null,
    projectId: t.projectId || null, createdAt: t.createdAt, updatedAt: t.updatedAt
  };
}

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    await db();

    if (req.method === 'GET') {
      const projectId = req.query?.projectId ? String(req.query.projectId) : null;
      const chatId = req.query?.chatId ? String(req.query.chatId) : undefined;
      const q = { ownerId: actor.id, projectId };
      if (chatId) q.chatId = chatId;
      if (req.query?.done === 'true') q.done = true;
      if (req.query?.done === 'false') q.done = false;
      const items = await Task.find(q).sort({ order: 1, createdAt: 1 }).limit(500).lean();
      return json(res, 200, { items: items.map(serialize) });
    }

    if (req.method === 'POST') {
      const b = await body(req);
      const title = String(b.title || '').trim().slice(0, 300);
      if (!title) return json(res, 400, { error: 'اكتب عنوان المهمة' });
      const projectId = b.projectId ? String(b.projectId) : null;
      const chatId = b.chatId ? String(b.chatId) : null;
      const priority = ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal';
      const dueDate = b.dueDate ? new Date(b.dueDate) : null;
      const last = await Task.findOne({ ownerId: actor.id, projectId }).sort({ order: -1 }).lean();
      const doc = await Task.create({
        ownerId: actor.id, projectId, chatId, title, priority,
        dueDate: dueDate && !isNaN(dueDate) ? dueDate : null,
        order: (last?.order ?? -1) + 1
      });
      await logActivity(projectId, actor.id, 'task.created', title);
      return json(res, 200, serialize(doc));
    }

    if (req.method === 'PATCH') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      const b = await body(req);

      // Bulk reorder: { order: [id1, id2, id3, ...] } sets each task's `order` to its
      // index in the array. Kept on the same route (not a separate endpoint) since it
      // always applies to one owner/project's task list as a whole.
      if (Array.isArray(b.reorder)) {
        const ops = b.reorder.map((taskId, idx) => ({
          updateOne: { filter: { _id: taskId, ownerId: actor.id }, update: { order: idx, updatedAt: new Date() } }
        }));
        if (ops.length) await Task.bulkWrite(ops);
        return json(res, 200, { ok: true, reordered: ops.length });
      }

      const update = { updatedAt: new Date() };
      if (typeof b.title === 'string' && b.title.trim()) update.title = b.title.trim().slice(0, 300);
      if (typeof b.done === 'boolean') update.done = b.done;
      if (['low', 'normal', 'high'].includes(b.priority)) update.priority = b.priority;
      if (b.dueDate !== undefined) { const d = b.dueDate ? new Date(b.dueDate) : null; update.dueDate = d && !isNaN(d) ? d : null; }
      if (Number.isInteger(b.order)) update.order = b.order;
      const doc = await Task.findOneAndUpdate({ _id: id, ownerId: actor.id }, update, { new: true }).lean();
      if (!doc) return json(res, 404, { error: 'المهمة غير موجودة' });
      if (typeof b.done === 'boolean') await logActivity(doc.projectId, actor.id, b.done ? 'task.completed' : 'task.reopened', doc.title);
      return json(res, 200, serialize(doc));
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      const doc = await Task.findOneAndDelete({ _id: id, ownerId: actor.id }).lean();
      if (!doc) return json(res, 404, { error: 'المهمة غير موجودة' });
      await logActivity(doc.projectId, actor.id, 'task.deleted', doc.title);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في المهام' });
  }
}

export default withLogging('/api/tasks', handlerImpl);
