// Global Chat Search — real substring search over each chat's title and message
// content, scoped strictly to the caller's own chats (never cross-user). No model
// call, no quota charge: this is a local Mongo query, same tier of cost as
// file-workspace's actionSearch.
import { db, Chat, json, withLogging } from './_lib.js';
import { requireUser } from './auth.js';

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    await db();

    const q = String(req.query?.q || '').trim();
    if (!q) return json(res, 400, { error: 'اكتب كلمة للبحث عنها' });
    const projectId = req.query?.projectId !== undefined ? (req.query.projectId ? String(req.query.projectId) : null) : undefined;
    const from = req.query?.from ? new Date(String(req.query.from)) : null;
    const to = req.query?.to ? new Date(String(req.query.to)) : null;
    const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
    const pageSize = 20;

    const filter = { ownerId: actor.id };
    if (projectId !== undefined) filter.projectId = projectId;
    if (from || to) {
      filter.updatedAt = {};
      if (from && !isNaN(from)) filter.updatedAt.$gte = from;
      if (to && !isNaN(to)) filter.updatedAt.$lte = to;
    }

    // Mongo regex on the array's nested field can't cheaply be indexed for this
    // shape, so at this project's real scale (per-user chat counts, not millions of
    // rows) a bounded scan of the user's own chats is the honest tradeoff — no fake
    // "full-text index" claim without one actually being built.
    const chats = await Chat.find(filter).select('title projectId messages updatedAt').limit(300).lean();
    const needle = q.toLowerCase();
    const results = [];
    for (const c of chats) {
      const titleHit = c.title?.toLowerCase().includes(needle);
      let messageHit = null;
      for (let i = 0; i < (c.messages || []).length; i++) {
        const m = c.messages[i];
        const idx = m.content?.toLowerCase().indexOf(needle);
        if (idx !== undefined && idx > -1) { messageHit = { index: i, role: m.role, snippet: m.content.slice(Math.max(0, idx - 60), idx + needle.length + 60) }; break; }
      }
      if (titleHit || messageHit) {
        results.push({
          chatId: String(c._id), title: c.title, projectId: c.projectId || null, updatedAt: c.updatedAt,
          matchedIn: titleHit && messageHit ? 'both' : titleHit ? 'title' : 'message',
          messageIndex: messageHit?.index ?? null, snippet: messageHit?.snippet || c.title
        });
      }
    }
    results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const total = results.length;
    const page = results.slice(offset, offset + pageSize);
    return json(res, 200, { query: q, results: page, total, offset, pageSize, hasMore: offset + pageSize < total });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'تعذر البحث' });
  }
}

export default withLogging('/api/chat-search', handlerImpl);
