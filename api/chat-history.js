import mongoose from 'mongoose';
import { db, Chat, json } from './_lib.js';
import { requireUser } from './auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    const u = await requireUser(req);
    const id = req.query?.id;
    // Validate before hitting Mongo: an invalid id would otherwise throw a
    // CastError that got reported as a generic failure instead of a clean 404.
    if (!id || !mongoose.isValidObjectId(id)) return json(res, 404, { error: 'المحادثة غير موجودة' });
    await db();
    const c = await Chat.findOne({ _id: id, ownerId: u.id }).lean();
    if (!c) return json(res, 404, { error: 'المحادثة غير موجودة' });
    return json(res, 200, { chat: c });
  } catch (e) {
    return json(res, e.status || 400, { error: e.message || 'تعذر تحميل المحادثة' });
  }
}
