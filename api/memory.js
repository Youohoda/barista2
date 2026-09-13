import mongoose from 'mongoose';
import { db, Memory, json } from './_lib.js';
import { requireUser } from './auth.js';

const CATEGORIES = ['preference', 'personal', 'project', 'decision', 'instruction', 'temporary'];

export default async function handler(req, res) {
  try {
    const actor = await requireUser(req);
    await db();

    if (req.method === 'GET') {
      const category = req.query?.category;
      const q = { ownerId: actor.id };
      if (category && CATEGORIES.includes(category)) q.category = category;
      const items = await Memory.find(q).sort({ importance: -1, createdAt: -1 }).limit(200).lean();
      return json(res, 200, {
        items: items.map(i => ({
          id: String(i._id), text: i.text, category: i.category, importance: i.importance,
          projectId: i.projectId || null, expiresAt: i.expiresAt || null, createdAt: i.createdAt
        }))
      });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (id === 'all') { await Memory.deleteMany({ ownerId: actor.id }); return json(res, 200, { ok: true }); }
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      await Memory.deleteOne({ _id: id, ownerId: actor.id });
      return json(res, 200, { ok: true });
    }

    // Manual add, so a user can teach Barista something without waiting for auto-extraction.
    if (req.method === 'POST') {
      let raw = '';
      await new Promise((resolve, reject) => {
        req.on('data', c => { raw += c; if (raw.length > 5000) reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 })); });
        req.on('end', resolve); req.on('error', reject);
      });
      let b; try { b = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'JSON غير صالح' }); }
      const text = String(b.text || '').trim().slice(0, 300);
      if (!text) return json(res, 400, { error: 'اكتب نص الذكرى أولاً' });
      const category = CATEGORIES.includes(b.category) ? b.category : 'personal';
      const importance = Number.isInteger(b.importance) && b.importance >= 1 && b.importance <= 5 ? b.importance : 3;
      const doc = { ownerId: actor.id, text, category, importance, projectId: b.projectId || null };
      if (category === 'temporary') doc.expiresAt = new Date(Date.now() + (Number(b.days) || 7) * 86400000);
      const saved = await Memory.create(doc);
      return json(res, 200, { id: String(saved._id), text: saved.text, category: saved.category, importance: saved.importance, createdAt: saved.createdAt });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في الذاكرة' });
  }
}
