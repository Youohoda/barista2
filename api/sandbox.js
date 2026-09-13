import { json, body, withLogging } from './_lib.js';
import { requireUser } from './auth.js';
import { getSandboxProvider } from './providers/sandbox.js';

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const b = await body(req);
    const action = String(b.action || 'execute');
    const provider = getSandboxProvider();

    if (action === 'create') return json(res, 200, await provider.create({ ownerId: actor.id }));
    if (action === 'write') return json(res, 200, { ok: true, ...(await provider.writeFile(b.workspaceId, b.path, b.content)) });
    if (action === 'execute') return json(res, 200, await provider.execute(b.workspaceId, b.command, { timeoutMs: b.timeoutMs || 10000, language: b.language }));
    if (action === 'destroy') return json(res, 200, { ok: true, ...(await provider.destroy(b.workspaceId)) });
    return json(res, 400, { error: 'action غير معروف' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في الـ Sandbox', code: e.code });
  }
}

export default withLogging('/api/sandbox', handlerImpl);
