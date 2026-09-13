import { json, body, withLogging } from './_lib.js';
import { requireUser } from './auth.js';
import { getBrowserProvider } from './providers/browser.js';

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const b = await body(req);
    const action = String(b.action || 'navigate');
    const provider = getBrowserProvider();

    if (action === 'launch') return json(res, 200, await provider.launch({ ownerId: actor.id }));
    if (action === 'navigate') return json(res, 200, await provider.navigate(b.sessionId, b.url));
    if (action === 'read') return json(res, 200, await provider.readPage(b.sessionId));
    if (action === 'find') return json(res, 200, { elements: await provider.findElements(b.sessionId, b.query) });
    if (action === 'click') { if (!b.authorized) return json(res, 400, { error: 'لازم authorized:true عشان تنفّذ click' }); return json(res, 200, { ok: true, ...(await provider.click(b.sessionId, b.selector)) }); }
    if (action === 'type') { if (!b.authorized) return json(res, 400, { error: 'لازم authorized:true عشان تنفّذ type' }); return json(res, 200, { ok: true, ...(await provider.type(b.sessionId, b.selector, b.text)) }); }
    if (action === 'screenshot') return json(res, 200, await provider.screenshot(b.sessionId));
    if (action === 'close') return json(res, 200, { ok: true, ...(await provider.close(b.sessionId)) });
    return json(res, 400, { error: 'action غير معروف' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في Browser Agent', code: e.code });
  }
}

export default withLogging('/api/browser-agent', handlerImpl);
