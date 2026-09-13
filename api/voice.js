import { json, body, withLogging } from './_lib.js';
import { requireUser } from './auth.js';
import { getSTTProvider, getTTSProvider } from './providers/voice.js';

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const b = await body(req);
    const action = String(b.action || 'transcribe');

    if (action === 'transcribe') {
      const stt = getSTTProvider();
      const buf = Buffer.from(String(b.audio || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
      return json(res, 200, await stt.transcribe(buf, { mimeType: b.mimeType, language: b.language }));
    }
    if (action === 'synthesize') {
      const tts = getTTSProvider();
      const out = await tts.synthesize(String(b.text || ''), { voice: b.voice, format: b.format });
      return json(res, 200, { mimeType: out.mimeType, audio: out.audioBuffer?.toString('base64') });
    }
    return json(res, 400, { error: 'action غير معروف' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في الصوت', code: e.code });
  }
}

export default withLogging('/api/voice', handlerImpl);
