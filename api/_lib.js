import mongoose from 'mongoose';

let cached = globalThis.__baristaMongo || { conn: null, promise: null };
globalThis.__baristaMongo = cached;

export async function db() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  if (cached.conn) return cached.conn;
  if (!cached.promise) cached.promise = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try { cached.conn = await cached.promise; } catch (e) { cached.promise = null; throw e; }
  return cached.conn;
}

const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user','assistant','system'], required: true },
  content: { type: String, required: true }, provider: String, model: String,
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const ChatSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  title: { type: String, default: 'محادثة جديدة' },
  messages: { type: [MessageSchema], default: [] }
}, { timestamps: true });
export const Chat = mongoose.models.BaristaChat || mongoose.model('BaristaChat', ChatSchema);

const UserSchema = new mongoose.Schema({
  clerkId: { type: String, unique: true, sparse: true, index: true },
  email: { type: String, lowercase: true, index: true },
  displayName: String, imageUrl: String,
  plan: { type: String, enum: ['free','gpt','go','plus','god'], default: 'free' },
  unlimited: { type: Boolean, default: false },
  premiumExpiresAt: Date,
  redeemedCodes: { type: [String], default: [] },
  dailyUsed: { type: Number, default: 0 },
  dailyResetAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const User = mongoose.models.BaristaUser || mongoose.model('BaristaUser', UserSchema);

export function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(data));
}
export function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 7_000_000) reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'),{status:413})); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('INVALID_JSON'),{status:400})); } });
    req.on('error', reject);
  });
}

function keys(prefix) {
  return Object.keys(process.env).filter(k => /^\d+$/.test(k.split('_').at(-1)) && k.startsWith(prefix + '_API_KEY_')).sort().map(k => process.env[k]).filter(Boolean);
}
async function request(url, key, payload, extra={}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}`, ...extra }, body: JSON.stringify(payload) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { throw new Error(`Provider returned non-JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.error?.message || data?.message || `Provider HTTP ${r.status}`);
  return data;
}
export async function providerChat(messages, preferred='barista-just') {
  const plans = {
    'barista-just': [['groq', process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'],['openrouter', process.env.OPENROUTER_MODEL || 'openrouter/free'],['cohere', process.env.COHERE_MODEL || 'command-a-03-2025']],
    'barista-fast': [['groq','llama-3.1-8b-instant'],['openrouter',process.env.OPENROUTER_MODEL || 'openrouter/free']],
    'barista-code': [['groq',process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'],['openrouter',process.env.OPENROUTER_MODEL || 'openrouter/free']],
    'barista-reasoning': [['openrouter',process.env.OPENROUTER_MODEL || 'openrouter/free'],['groq',process.env.GROQ_MODEL || 'llama-3.3-70b-versatile']]
  };
  const errors=[];
  for (const [p, model] of (plans[preferred] || plans['barista-just'])) {
    for (const key of keys(p.toUpperCase())) {
      try {
        if (p === 'groq') { const d=await request('https://api.groq.com/openai/v1/chat/completions',key,{model,messages,temperature:.35}); return {text:d.choices?.[0]?.message?.content||'',provider:p,model}; }
        if (p === 'openrouter') { const d=await request('https://openrouter.ai/api/v1/chat/completions',key,{model,messages,temperature:.35},{'HTTP-Referer':process.env.BARISTA_APP_URL||'https://barista-ai.vercel.app','X-Title':'Barista AI'}); return {text:d.choices?.[0]?.message?.content||'',provider:p,model}; }
        const d=await request('https://api.cohere.com/v2/chat',key,{model,messages,temperature:.35}); return {text:d.message?.content?.map(x=>x.text||'').join('')||'',provider:p,model};
      } catch(e){ errors.push(`${p}: ${e.message}`); }
    }
  }
  throw new Error(errors.length ? `كل مزودي الذكاء الاصطناعي فشلوا: ${errors.join(' | ')}` : 'لم يتم ضبط أي API key.');
}
