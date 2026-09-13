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
  projectId: { type: String, default: null, index: true }, // null = standalone chat, not tied to a project
  title: { type: String, default: 'محادثة جديدة' },
  messages: { type: [MessageSchema], default: [] },
  // Rolling summary of everything older than the last KEEP_RECENT messages (see chat.js),
  // so long conversations don't just fall off a hard slice(-18) window.
  summary: { type: String, default: '' },
  // Index into `messages` up to which `summary` already accounts for. Messages before
  // this index are folded into `summary` and no longer sent to the model verbatim.
  summarizedCount: { type: Number, default: 0 }
}, { timestamps: true });
export const Chat = mongoose.models.BaristaChat || mongoose.model('BaristaChat', ChatSchema);

// One row per remembered fact about a user, extracted from their own messages.
// Deliberately flat (no per-chat scoping) — memory is meant to follow the user
// across every conversation, not just the one it was learned in.
// `category` splits facts so retrieval/UI can filter (preference/personal/project/
// decision/instruction/temporary). `importance` (1-5) ranks what gets kept in the
// context budget when there are more facts than fit. `expiresAt` is only set for
// `temporary` facts (e.g. "مسافر لحد الخميس") — TTL-indexed so Mongo drops them itself.
const MemorySchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  projectId: { type: String, default: null, index: true }, // null = follows the user everywhere; set = scoped to one project
  text: { type: String, required: true },
  category: { type: String, enum: ['preference', 'personal', 'project', 'decision', 'instruction', 'temporary'], default: 'personal' },
  importance: { type: Number, min: 1, max: 5, default: 3 },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
MemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Memory = mongoose.models.BaristaMemory || mongoose.model('BaristaMemory', MemorySchema);

// A Project groups chats + workspace files + a fixed instructions string under one
// isolated context, e.g. "Revo Bot — Node.js + discord.js 14". ownerId scoping means
// one user's projects are never visible to another; there is no cross-project bleed
// because Chat/WorkspaceFile/Memory rows all carry their own projectId and every query
// in this file filters by {ownerId, projectId} together, never projectId alone.
// Sub-schema kept separate (rather than inlined as `detected: { type: {...} }`) because
// one of its own fields is itself named `type` — inlining it would collide with
// Mongoose's `{ type: ... }` shorthand for declaring a path's type and silently
// misparse the schema.
const DetectedProjectInfoSchema = new mongoose.Schema({
  type: { type: String, default: null },
  language: { type: String, default: null },
  framework: { type: String, default: null },
  runtime: { type: String, default: null },
  database: { type: String, default: null },
  buildSystem: { type: String, default: null },
  packageManager: { type: String, default: null },
  testFramework: { type: String, default: null },
  dependencies: { type: [String], default: [] },
  confidence: { type: Number, default: 0 },
  matchedDetectors: { type: [String], default: [] },
  detectedAt: { type: Date, default: null }
}, { _id: false });

const ProjectSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  name: { type: String, required: true },
  instructions: { type: String, default: '' }, // sent to the agent automatically on every request scoped to this project
  archived: { type: Boolean, default: false }, // hidden from the default switcher/list, not deleted — data stays intact
  // Populated by POST /api/projects?id=..&action=detect (api/_project-detect.js) from
  // the project's own uploaded files — never hand-set by the client, and null until
  // detection has actually run at least once. Generic across any project type
  // (Discord bot, Roblox game, Next.js site, ...), not just Barista itself.
  detected: { type: DetectedProjectInfoSchema, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
ProjectSchema.index({ ownerId: 1, name: 1 });
export const Project = mongoose.models.BaristaProject || mongoose.model('BaristaProject', ProjectSchema);

// A saved recurring instruction ("كل يوم الساعة 8 ابحث عن أخبار AI واعمل ملخص").
// Executed by api/cron-automations.js, which Vercel Cron hits once a day (see
// vercel.json) — on Vercel's free/hobby tier that is the maximum cron frequency
// available, so `hour`/`daysOfWeek` are evaluated against that single daily trigger;
// true hourly/minute-level scheduling needs a Pro plan cron or an external scheduler.
const AutomationSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  prompt: { type: String, required: true },
  model: { type: String, default: 'barista-just' },
  hour: { type: Number, min: 0, max: 23, default: 8 }, // UTC hour to run on
  daysOfWeek: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=Sunday
  enabled: { type: Boolean, default: true },
  lastRunAt: Date,
  lastStatus: { type: String, enum: ['ok', 'error', null], default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const Automation = mongoose.models.BaristaAutomation || mongoose.model('BaristaAutomation', AutomationSchema);

// Execution history for automations, so a user (or admin) can see what actually ran
// and what it produced/failed with — no run is ever silently dropped.
const AutomationRunSchema = new mongoose.Schema({
  automationId: { type: String, index: true, required: true },
  ownerId: { type: String, index: true, required: true },
  status: { type: String, enum: ['ok', 'error'], required: true },
  output: String,
  error: String,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const AutomationRun = mongoose.models.BaristaAutomationRun || mongoose.model('BaristaAutomationRun', AutomationRunSchema);

// Rolling per-provider/model counters the Model Router and a future admin view read
// from — real numbers from real calls (see recordProviderResult in _router.js), not
// invented statistics. One row per provider+model pair, incremented in place.
const ProviderStatSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  model: { type: String, required: true },
  success: { type: Number, default: 0 },
  failure: { type: Number, default: 0 },
  totalLatencyMs: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
ProviderStatSchema.index({ provider: 1, model: 1 }, { unique: true });
export const ProviderStat = mongoose.models.BaristaProviderStat || mongoose.model('BaristaProviderStat', ProviderStatSchema);

// Persisted per-user file workspace. Previously file-workspace.js was a pure one-shot
// endpoint (extract → ask model → forget); this keeps the extracted text around so a
// user can search across everything they've uploaded, or ask for a diff between two
// files, without re-uploading. Content is capped the same way the one-shot path was.
const WorkspaceFileSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  projectId: { type: String, default: null, index: true }, // null = general workspace, not tied to a project
  name: { type: String, required: true },
  mime: String,
  content: { type: String, default: '' },
  size: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
WorkspaceFileSchema.index({ ownerId: 1, projectId: 1, name: 1 });
export const WorkspaceFile = mongoose.models.BaristaWorkspaceFile || mongoose.model('BaristaWorkspaceFile', WorkspaceFileSchema);

const UserSchema = new mongoose.Schema({
  clerkId: { type: String, unique: true, sparse: true, index: true },
  email: { type: String, lowercase: true, index: true },
  displayName: String, imageUrl: String,
  plan: { type: String, enum: ['free','gpt','go','plus','god'], default: 'free' },
  unlimited: { type: Boolean, default: false },
  premiumExpiresAt: Date,
  redeemedCodes: { type: [String], default: [] },
  giftClaims: { type: [String], default: [] },
  dailyUsed: { type: Number, default: 0 },
  dailyResetAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const User = mongoose.models.BaristaUser || mongoose.model('BaristaUser', UserSchema);

const GiftSchema = new mongoose.Schema({
  name: { type: String, default: 'هدية Barista' },
  target: { type: String, enum: ['user','all','country'], required: true },
  email: { type: String, lowercase: true, index: true },
  country: { type: String, uppercase: true },
  plan: { type: String, enum: ['gpt','go','plus','god'], required: true },
  durationValue: { type: Number, required: true },
  durationUnit: { type: String, enum: ['days','weeks','months','years'], required: true },
  startsAt: { type: Date, default: Date.now },
  endsAt: Date,
  active: { type: Boolean, default: true },
  maxClaims: { type: Number, default: 0 },
  claims: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const Gift = mongoose.models.BaristaGift || mongoose.model('BaristaGift', GiftSchema);

// One row per checkout attempt. Created "pending" when the user starts checkout,
// flipped to "paid" only once the provider's webhook confirms the money actually
// arrived (never on the client redirect alone — that step is not trustworthy).
const OrderSchema = new mongoose.Schema({
  ref: { type: String, unique: true, index: true, required: true }, // our own order id, sent to the provider
  ownerId: { type: String, index: true, required: true },
  email: String,
  plan: { type: String, enum: ['gpt', 'go', 'plus'], required: true },
  months: { type: Number, default: 1 },
  provider: { type: String, enum: ['paymob', 'stripe', 'fawry'], required: true },
  amount: { type: Number, required: true }, // in the currency's smallest unit is NOT assumed — see currency
  currency: { type: String, required: true }, // 'EGP' | 'USD'
  status: { type: String, enum: ['pending', 'paid', 'failed', 'expired'], default: 'pending', index: true },
  providerRef: String, // paymob order id / stripe session id / fawry merchantRefNumber echo
  providerPayload: mongoose.Schema.Types.Mixed, // last raw webhook payload, kept for support/debugging
  paidAt: Date,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
export const Order = mongoose.models.BaristaOrder || mongoose.model('BaristaOrder', OrderSchema);


// ---- Tasks: real to-do items tied to a chat/project, not decorative -------------
// The agent (see _tools.js create_task/update_task) and the user both write to the
// same collection, so "الخطة" a plan produces and the checklist the user manages by
// hand are the same rows, not two parallel systems.
const TaskSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, required: true },
  projectId: { type: String, default: null, index: true },
  chatId: { type: String, default: null, index: true },
  title: { type: String, required: true },
  done: { type: Boolean, default: false },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  dueDate: { type: Date, default: null },
  order: { type: Number, default: 0 }, // manual drag-reorder position, lowest first
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
TaskSchema.index({ ownerId: 1, projectId: 1, order: 1 });
export const Task = mongoose.models.BaristaTask || mongoose.model('BaristaTask', TaskSchema);

// ---- Collaboration: real roles + activity log, no fake realtime -----------------
// A project's owner (Project.ownerId) can add members with a role. Every query that
// should honor sharing must check canAccessProject() (exported below) instead of
// comparing ownerId alone — see README-V28 "Final Audit" note on which routes do
// this today vs which still only check strict ownership.
const ProjectMemberSchema = new mongoose.Schema({
  projectId: { type: String, index: true, required: true },
  userId: { type: String, index: true, required: true }, // Clerk user id of the member
  email: { type: String, lowercase: true }, // resolved at invite time, for display without another lookup
  role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'viewer' },
  invitedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
ProjectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });
export const ProjectMember = mongoose.models.BaristaProjectMember || mongoose.model('BaristaProjectMember', ProjectMemberSchema);

const ActivityLogSchema = new mongoose.Schema({
  projectId: { type: String, index: true, required: true },
  actorId: { type: String, required: true },
  action: { type: String, required: true }, // e.g. 'member.added', 'file.write', 'project.rename'
  detail: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
ActivityLogSchema.index({ projectId: 1, createdAt: -1 });
export const ActivityLog = mongoose.models.BaristaActivityLog || mongoose.model('BaristaActivityLog', ActivityLogSchema);

export async function logActivity(projectId, actorId, action, detail = '') {
  if (!projectId) return; // activity log is project-scoped only; standalone chats have nothing to log against
  try { await ActivityLog.create({ projectId, actorId, action, detail: String(detail).slice(0, 500) }); } catch { /* never block the real action on a logging failure */ }
}

// True if `actor` may access `project` at all (owner, or any listed role). Every new
// route in V28 (tasks, collaboration) uses this instead of a bare ownerId match, so
// a shared project actually behaves shared. Existing routes written before V28
// (chat.js, file-workspace.js, memory.js, projects.js CRUD) still check strict
// ownerId only — flagged explicitly in the final report, not silently changed,
// because retrofitting them changes who can trigger billing-relevant usage.
export async function canAccessProject(actor, projectId, minRole = 'viewer') {
  if (!projectId) return { ok: true, role: 'owner' };
  const project = await Project.findOne({ _id: projectId }).lean();
  if (!project) return { ok: false, role: null };
  if (project.ownerId === actor.id) return { ok: true, role: 'owner' };
  const member = await ProjectMember.findOne({ projectId, userId: actor.id }).lean();
  if (!member) return { ok: false, role: null };
  const rank = { viewer: 0, editor: 1, owner: 2 };
  return { ok: rank[member.role] >= rank[minRole], role: member.role };
}

// ---- Structured logging + request IDs (Monitoring / Observability) --------------
// One JSON line per request, written to stdout (Vercel's log pipeline picks this up
// as-is — no separate log shipper needed to get structured, greppable logs). Never
// includes secrets: only route/status/latency/ids, never headers or bodies.
export function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
export function logEvent(event) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), ...event })); } catch { /* never throw from logging */ }
}
// Wraps a Vercel handler with a request id, latency measurement, and a guaranteed
// one-line structured log per call (success or failure) — used by new endpoints;
// not retrofitted onto pre-V28 handlers to avoid changing their error response shape.
export function withLogging(routeName, handler) {
  return async function wrapped(req, res) {
    const requestId = genRequestId();
    const startedAt = Date.now();
    req.requestId = requestId; // handlers may set req.ownerId once they know who the caller is
    res.setHeader('X-Request-Id', requestId);
    const persist = (status, error) => {
      const latencyMs = Date.now() - startedAt;
      logEvent({ requestId, route: routeName, method: req.method, status, ownerId: req.ownerId || null, error, latencyMs });
      RequestLog.create({ requestId, route: routeName, method: req.method, status, ownerId: req.ownerId || null, latencyMs, error }).catch(() => {});
    };
    try {
      const result = await handler(req, res);
      persist(res.statusCode, undefined);
      return result;
    } catch (e) {
      persist(e.status || 500, e.message);
      throw e;
    }
  };
}

// Minimal request outcome record for the admin dashboard (api/admin.js) to read real
// numbers from. TTL'd at 30 days so it never grows unbounded on its own.
const RequestLogSchema = new mongoose.Schema({
  requestId: String, route: { type: String, index: true }, method: String,
  status: Number, ownerId: String, latencyMs: Number, error: String,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
RequestLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
export const RequestLog = mongoose.models.BaristaRequestLog || mongoose.model('BaristaRequestLog', RequestLogSchema);

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
// Like body(), but returns the raw string instead of parsing it — needed for webhook
// signature verification (e.g. Stripe), where hashing a re-serialized JSON object would
// not match the signature computed over the original bytes.
export function rawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'),{status:413})); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function keys(prefix) {
  return Object.keys(process.env).filter(k => /^\d+$/.test(k.split('_').at(-1)) && k.startsWith(prefix + '_API_KEY_')).sort().map(k => process.env[k]).filter(Boolean);
}
async function request(url, key, payload, extra={}, timeoutMs=25000) {
  const attempt = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}`, ...extra }, body: JSON.stringify(payload), signal: ctrl.signal });
      const text = await r.text(); let data; try { data = JSON.parse(text); } catch { throw new Error(`Provider returned non-JSON (${r.status})`); }
      if (!r.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `Provider HTTP ${r.status}`), { retryable: r.status===429 || r.status>=500 });
      return data;
    } finally { clearTimeout(timer); }
  };
  try { return await attempt(); }
  catch (e) {
    const retryable = e.name==='AbortError' || e.retryable || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(e.message||'');
    if (!retryable) throw e;
    return attempt(); // single retry on timeout / transient failure
  }
}
// Fire-and-forget usage counter update — never awaited by a caller, never throws into
// the response path. This is the only source for the numbers the Model Router's
// cost-awareness and any future admin view read (see ProviderStat in this file);
// nothing here is a made-up figure.
function recordProviderResult(provider, model, ok, latencyMs) {
  ProviderStat.findOneAndUpdate(
    { provider, model },
    { $inc: { [ok ? 'success' : 'failure']: 1, totalLatencyMs: latencyMs }, $set: { updatedAt: new Date() } },
    { upsert: true }
  ).exec().catch(() => {});
}

// `tools` (optional) is an OpenAI-format function-calling array. Only groq and openrouter
// speak that format here — if the chain falls back to cohere, tools are silently dropped
// rather than failing the whole request; the model just answers without them.
export async function providerChat(messages, preferred='barista-just', attachments=[], tools=null) {
  const plans = {
    'barista-just': [['groq', process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'],['openrouter', process.env.OPENROUTER_MODEL || 'openrouter/free'],['cohere', process.env.COHERE_MODEL || 'command-a-03-2025']],
    'barista-fast': [['groq','llama-3.1-8b-instant'],['openrouter',process.env.OPENROUTER_MODEL || 'openrouter/free']],
    'barista-code': [['groq',process.env.GROQ_CODE_MODEL || 'llama-3.3-70b-versatile'],['openrouter',process.env.OPENROUTER_CODE_MODEL || 'qwen/qwen-2.5-coder-32b-instruct:free'],['openrouter', process.env.OPENROUTER_MODEL || 'openrouter/free'],['cohere', process.env.COHERE_MODEL || 'command-a-03-2025']],
    'barista-reasoning': [['openrouter',process.env.OPENROUTER_MODEL || 'openrouter/free'],['groq',process.env.GROQ_MODEL || 'llama-3.3-70b-versatile']]
  };
  const errors=[];
  const imageAttachments=(attachments||[]).filter(a=>a?.type==='image' && typeof a.dataUrl==='string');
  for (const [p, model] of (plans[preferred] || plans['barista-just'])) {
    if (imageAttachments.length && p !== 'openrouter') continue;
    for (const key of keys(p.toUpperCase())) {
      const startedAt = Date.now();
      try {
        if (p === 'groq') {
          const d=await request('https://api.groq.com/openai/v1/chat/completions',key,{model,messages,temperature:.35,...(tools?{tools,tool_choice:'auto'}:{})});
          const msg=d.choices?.[0]?.message||{};
          recordProviderResult(p, model, true, Date.now()-startedAt);
          return {text:msg.content||'',provider:p,model,toolCalls:msg.tool_calls||null};
        }
        if (p === 'openrouter') {
          let payloadMessages=messages;
          if (imageAttachments.length) {
            const last=[...messages].reverse().find(m=>m.role==='user');
            if (last) {
              const parts=[{type:'text',text:last.content||'حلل الصورة المرفقة وأجب عن طلبي.'}];
              for(const a of imageAttachments.slice(0,4)) parts.push({type:'image_url',image_url:{url:a.dataUrl}});
              payloadMessages=messages.map(m=>m===last?{...m,content:parts}:m);
            }
          }
          const d=await request('https://openrouter.ai/api/v1/chat/completions',key,{model,messages:payloadMessages,temperature:.35,...(tools?{tools,tool_choice:'auto'}:{})},{'HTTP-Referer':process.env.BARISTA_APP_URL||'https://barista-ai.vercel.app','X-Title':'Barista AI'});
          const msg=d.choices?.[0]?.message||{};
          recordProviderResult(p, model, true, Date.now()-startedAt);
          return {text:msg.content||'',provider:p,model,toolCalls:msg.tool_calls||null};
        }
        const d=await request('https://api.cohere.com/v2/chat',key,{model,messages,temperature:.35});
        recordProviderResult(p, model, true, Date.now()-startedAt);
        return {text:d.message?.content?.map(x=>x.text||'').join('')||'',provider:p,model,toolCalls:null};
      } catch(e){ recordProviderResult(p, model, false, Date.now()-startedAt); errors.push(`${p}: ${e.message}`); }
    }
  }
  if(imageAttachments.length && !keys('OPENROUTER'.toUpperCase()).length) throw new Error('تحليل الصور يحتاج مفتاح OpenRouter صالح.');
  throw new Error(errors.length ? `كل مزودي الذكاء الاصطناعي فشلوا: ${errors.join(' | ')}` : 'لم يتم ضبط أي API key.');
}

// Live web search, used as a tool the model can call mid-conversation (see chat.js).
// Needs BRAVE_API_KEY (free tier at api.search.brave.com). Kept as a single small
// helper so swapping providers later (Tavily, Bing, etc.) means editing one function.
export async function webSearch(query, count=5) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('البحث في الإنترنت يحتاج BRAVE_API_KEY في متغيرات البيئة.');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch { throw new Error('نتيجة بحث غير صالحة'); }
  if (!r.ok) throw new Error(d?.message || `Brave search HTTP ${r.status}`);
  return (d.web?.results || []).slice(0, count).map(x => ({ title: x.title || x.url, url: x.url, snippet: x.description || '' }));
}

export async function providerImage(prompt) {
  const model = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image-preview';
  const orKeys = keys('OPENROUTER');
  if (!orKeys.length) throw new Error('توليد الصور يحتاج مفتاح OpenRouter صالح (OPENROUTER_API_KEY_1).');
  const errors = [];
  for (const key of orKeys) {
    try {
      const d = await request('https://openrouter.ai/api/v1/chat/completions', key, {
        model,
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content: String(prompt || 'صورة إبداعية عالية الجودة').slice(0, 2000) }]
      }, { 'HTTP-Referer': process.env.BARISTA_APP_URL || 'https://barista-ai.vercel.app', 'X-Title': 'Barista AI' });
      const msg = d.choices?.[0]?.message || {};
      const img = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url;
      if (!img) throw new Error('الموديل لم يرجّع صورة. جرّب صياغة أوضح للوصف.');
      return { url: img, text: msg.content || '', provider: 'openrouter', model };
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`تعذّر توليد الصورة: ${errors.join(' | ')}`);
}
