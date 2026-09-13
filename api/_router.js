// Barista Brain / Smart Model Router — single place that decides *which* Barista
// model handles a request when the user picks "barista-auto" instead of a specific
// mode, plus a couple of shared helpers (context budget, provider health) that used
// to live scattered inline. Nothing here talks to a provider directly — it only
// returns a decision; api/_lib.js's providerChat still does the actual calling and
// fallback chain, so this module can't drift out of sync with what providers/keys
// actually exist.
import { ProviderStat, WorkspaceFile } from './_lib.js';

// ---- 1. Intent classification --------------------------------------------------
// Heuristic-first on purpose (Cost Optimization requirement): classifying every
// message with an extra model call would double the cost of every "auto" request.
// A regex pass handles the large majority of clear cases for free; only a genuinely
// ambiguous message (no signal either way) pays for one cheap barista-fast call.
const CODE_SIGNAL = /```|\berror\b|exception|stack ?trace|traceback|undefined is not|npm |pip |function\s*\(|=>|SELECT .* FROM|def |class \w+|import |console\.log|كود|فنكشن|داله|السكربت|الفانكشن|اكتب لي كود|صلح الكود|debug|bug\b/i;
const REASONING_SIGNAL = /قارن|حلل بعمق|خطوة بخطوة|استراتيجي|analy[sz]e in depth|step by step|compare .* and|trade-?off|لماذا|why (does|is)|اثبت|prove|optimi[sz]e/i;
const IMAGE_SIGNAL = /ارسم|صمم صورة|اعمل صورة|generate (an? )?image|draw (a|an)/i;
const SIMPLE_SIGNAL = /^(ايه رأيك|إزيك|هاي|hi|hello|مرحبا|شكرا|thanks|ok|تمام)\b/i;

export async function classifyIntent(message, { hasAttachmentImage = false, hasProjectFiles = false } = {}) {
  const text = String(message || '');
  if (hasAttachmentImage) return { model: 'barista-just', reason: 'attachment:image (vision goes through barista-just/openrouter today)' };
  if (IMAGE_SIGNAL.test(text)) return { model: 'barista-image', reason: 'image-generation phrasing detected' };
  if (CODE_SIGNAL.test(text) || hasProjectFiles) return { model: 'barista-code', reason: 'code signal or active project files' };
  if (REASONING_SIGNAL.test(text) || text.length > 600) return { model: 'barista-reasoning', reason: 'multi-step / deep-analysis phrasing or long prompt' };
  if (SIMPLE_SIGNAL.test(text) || text.length < 12) return { model: 'barista-fast', reason: 'short/simple message' };
  // Ambiguous — fall through to barista-just, which is the general-purpose default
  // and cheaper than paying for a classification call on every uncertain message.
  return { model: 'barista-just', reason: 'no strong signal, defaulting to general-purpose model' };
}

// ---- 2. Provider health / cost awareness ---------------------------------------
// Reads the real counters written by recordProviderResult() in _lib.js. Returns []
// if the ProviderStat collection is empty (fresh install) rather than inventing rows.
export async function getProviderHealth() {
  const rows = await ProviderStat.find({}).lean();
  return rows.map(r => ({
    provider: r.provider,
    model: r.model,
    success: r.success,
    failure: r.failure,
    successRate: (r.success + r.failure) ? +(r.success / (r.success + r.failure) * 100).toFixed(1) : null,
    avgLatencyMs: r.success ? Math.round(r.totalLatencyMs / Math.max(1, r.success + r.failure)) : null,
    updatedAt: r.updatedAt
  }));
}

// ---- 3. Context engine ----------------------------------------------------------
// Merges the pieces chat.js gathers (recent messages, rolling summary, memory
// facts, project instructions, relevant files) inside a character budget so a
// request never balloons just because a project has a lot of memory/files attached.
// Priority when trimming: project instructions > memory > file excerpts (recent
// messages are handled separately in chat.js and always kept in full).
const CONTEXT_CHAR_BUDGET = 6000;

export function assembleContext({ projectInstructions = '', memoryText = '', fileExcerpts = [] } = {}) {
  let budget = CONTEXT_CHAR_BUDGET;
  const parts = [];
  if (projectInstructions) {
    const chunk = projectInstructions.slice(0, Math.min(800, budget));
    parts.push(`تعليمات المشروع الثابتة:\n${chunk}`);
    budget -= chunk.length;
  }
  if (memoryText && budget > 200) {
    const chunk = memoryText.slice(0, budget - 100);
    parts.push(chunk);
    budget -= chunk.length;
  }
  for (const f of fileExcerpts) {
    if (budget < 200) break;
    const chunk = String(f.content || '').slice(0, Math.min(1500, budget));
    parts.push(`ملف ذو صلة "${f.name}":\n${chunk}`);
    budget -= chunk.length;
  }
  return parts.join('\n\n');
}

// Picks which uploaded project files are worth injecting as extra context for a
// given message — plain keyword overlap (no vector DB in this stack), capped to a
// handful of files so it never dominates the budget above.
export async function relevantFiles(ownerId, projectId, message, limit = 2) {
  if (!projectId) return [];
  const files = await WorkspaceFile.find({ ownerId, projectId }).select('name content').lean();
  if (!files.length) return [];
  const words = String(message || '').toLowerCase().match(/[a-z0-9أ-ي]{3,}/g) || [];
  if (!words.length) return [];
  const scored = files.map(f => {
    const hay = (f.name + ' ' + f.content.slice(0, 4000)).toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    return { ...f, score };
  }).filter(f => f.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
