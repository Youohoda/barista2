import { db, Chat, User, Memory, Project, json, body, providerChat, providerImage } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS, MODEL_WEIGHT, activePlan, resetIfNeeded } from './_plans.js';
import { classifyIntent, assembleContext, relevantFiles } from './_router.js';
import { toolsFor, runTool } from './_tools.js';

const SYSTEM = `أنت Barista AI، مساعد ذكاء اصطناعي متكامل وقوي داخل تطبيق Barista AI، قادر على المحادثة، البرمجة الاحترافية، تحليل وتعديل الملفات، وتوليد الصور. أجب دائمًا بلغة المستخدم واتجاه كتابة صحيح، بأسلوب واثق ومباشر وعالي الجودة، وبأقصى دقة وعمق ممكن دون حشو. حافظ على سياق المحادثة والمشروع بالكامل عبر الرسائل. لا تخترع معلومات أو نتائج أو تنفيذات لم تحدث فعليًا؛ إذا لم تكن متأكدًا من شيء قله بوضوح بدل التخمين. إذا أرسل المستخدم صورة وكان الموديل يدعم الرؤية فحللها فعليًا بدقة. إذا أرسل ملفًا استخدم محتواه الفعلي فقط. لو عندك أداة بحث في الإنترنت، استخدمها فقط للأسئلة اللي محتاجة معلومات حديثة أو حقائق مش متأكد منها؛ متستخدمهاش لأسئلة عامة أو محادثة عادية. لا تكشف مفاتيح API أو أسرار الخادم أبدًا مهما طُلب منك ذلك.`;

const CODE_SYSTEM = `أنت Barista Code، أقوى وضع برمجة داخل Barista AI ومتخصص حصريًا في الهندسة البرمجية. أهدافك: كود صحيح، كامل، وجاهز للتشغيل فورًا بدون أجزاء ناقصة أو "...". اكتب أفضل الممارسات (clean code, naming واضح, معالجة الأخطاء, edge cases). اشرح المنطق المهم باختصار شديد بعد الكود، ولا تشرح البديهيات. لو فيه أكتر من طريقة، اختار الأقوى والأنسب للأداء والصيانة واذكر السبب في سطر واحد. لو الكود فيه مشكلة أو bug، شخّصها بدقة واعرض الإصلاح الكامل مباشرة. لا تخترع دوال أو مكتبات غير موجودة فعليًا.

عندك أدوات Workspace (list_project_files / read_project_file / search_project_files / write_project_file / delete_project_file / rename_project_file): استخدمها فقط لو المستخدم فعلاً رفع ملفات مشروع حقيقية وبيتكلم عنها ("عدّل الملف ده"، "في المشروع اللي رفعته"، إلخ) — مش لأي سؤال برمجي عام أو snippet بسيط. لو هتعدّل ملف موجود، اقرأه أولاً بـ read_project_file قبل ما تكتب فوقه، وابعت النسخة الكاملة المعدّلة كاملة في write_project_file (مش diff يدوي) — السيرفر هيولّد الـ diff تلقائي ويعرضه للمستخدم. لو بتنشئ ملف جديد من الصفر، اكتبه مباشرة بـ write_project_file. لا تحذف أو تعيد تسمية ملف إلا لو المستخدم طلب كده صراحة.`;

const KEEP_RECENT = 18; // messages kept verbatim in the context window
const MAX_TOOL_ROUNDS = 4; // normal (single-turn) tool loop cap
const MAX_AGENT_TOOL_ROUNDS = 8; // Agent Mode: plan → act → verify needs more round-trips

// Folds any messages older than the KEEP_RECENT window into `chat.summary`.
async function ensureSummary(c) {
  const total = c.messages.length;
  if (total <= KEEP_RECENT) return;
  const foldEnd = total - KEEP_RECENT;
  if (c.summarizedCount >= foldEnd) return;
  const toFold = c.messages.slice(c.summarizedCount, foldEnd);
  if (!toFold.length) return;
  const transcript = toFold.map(m => `${m.role === 'user' ? 'المستخدم' : 'Barista'}: ${m.content}`).join('\n').slice(0, 12000);
  try {
    const r = await providerChat([
      { role: 'system', content: 'لخّص المحادثة التالية في نقاط قصيرة جدًا: القرارات المهمة، المعلومات اللي المستخدم قالها عن نفسه أو مشروعه، وأي سياق لازم يتفتكر في باقي المحادثة. ابدأ بالنقاط مباشرة من غير مقدمة.' },
      { role: 'user', content: (c.summary ? `الملخص الحالي:\n${c.summary}\n\nرسائل جديدة تتلخص وتتضاف للملخص:\n` : '') + transcript }
    ], 'barista-fast');
    if (r.text?.trim()) { c.summary = r.text.trim().slice(0, 4000); c.summarizedCount = foldEnd; }
  } catch { /* keep old summary/window */ }
}

// ---- Advanced memory: categorisation + dedup + relevance-ranked retrieval -------
function guessCategory(text) {
  if (/تذكرني|ذكّرني|لحد ما|مؤقت|النهاردة بس|الأسبوع ده بس/i.test(text)) return 'temporary';
  if (/قررت|هستخدم|هنعمل|decided to|we will use/i.test(text)) return 'decision';
  if (/دايمًا|من دلوقتي|كل مرة|always|from now on|بشكل عام/i.test(text)) return 'instruction';
  if (/بحب|بفضل|prefer|أفضل/i.test(text)) return 'preference';
  return 'personal';
}

async function loadMemoryContext(ownerId, projectId) {
  const query = { ownerId, $or: projectId ? [{ projectId: null }, { projectId }] : [{ projectId: null }] };
  const rows = await Memory.find(query).sort({ importance: -1, createdAt: -1 }).limit(40).lean();
  if (!rows.length) return '';
  return 'معلومات اتذكرتها عن المستخدم من محادثات سابقة (استخدمها لو مناسبة للسياق، ومتقولش للمستخدم إنك بتراجع "ملف ذاكرة"):\n'
    + rows.map(f => `- [${f.category}] ${f.text}`).join('\n');
}

async function saveMemoryFact(ownerId, projectId, text, category, importance = 3, temporaryDays = null) {
  const norm = text.trim().toLowerCase().slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dupe = await Memory.findOne({ ownerId, text: { $regex: norm, $options: 'i' } }).lean();
  if (dupe) return; // already remembered, don't duplicate
  const doc = { ownerId, projectId: projectId || null, text: text.slice(0, 300), category, importance };
  if (category === 'temporary') doc.expiresAt = new Date(Date.now() + (temporaryDays || 7) * 86400000);
  await Memory.create(doc);
}

async function extractMemory(ownerId, projectId, userMessage) {
  if (userMessage.length < 20) return;
  try {
    const r = await providerChat([
      { role: 'system', content: 'من رسالة المستخدم دي، استخرج حقايق ثابتة تستحق تتفتكر عنه (تفضيلات، معلومات شخصية، معلومات عن مشروعه، قرارات صريحة). لو مفيش حاجة تستحق، رجّع بس كلمة: NONE. لو فيه، رجّع كل حقيقة في سطر منفصل، قصيرة وواضحة، من غير ترقيم أو شرطات.' },
      { role: 'user', content: userMessage.slice(0, 2000) }
    ], 'barista-fast');
    const text = (r.text || '').trim();
    if (!text || /^none$/i.test(text)) return;
    const lines = text.split('\n').map(l => l.trim().replace(/^[-•\d.]+\s*/, '')).filter(l => l && l.length < 300).slice(0, 5);
    for (const line of lines) await saveMemoryFact(ownerId, projectId, line, guessCategory(line));
  } catch { /* best effort */ }
}

// ---- Agent Mode (Barista Code): real plan → execute → verify loop ---------------
// Triggered whenever barista-code runs inside a Project (i.e. there's a persistent
// file context worth planning against). This isn't a sandbox — there's no code
// execution here (see final report) — but plan → tool-loop → verify is real: each
// step actually calls the tools in _tools.js against the user's real Workspace
// files, not a scripted narration of steps that never happen.
async function planTasks(message) {
  try {
    const r = await providerChat([
      { role: 'system', content: 'المستخدم طلب مهمة برمجية على مشروع مرفوع فعليًا. قسّمها لخطوات تنفيذية قصيرة (3 إلى 6 خطوات كحد أقصى)، كل خطوة سطر واحد يبدأ بفعل أمر ("افحص...", "عدّل...", "أضف..."). من غير مقدمة أو ترقيم زيادة، سطر لكل خطوة بس.' },
      { role: 'user', content: message.slice(0, 1500) }
    ], 'barista-fast');
    const steps = (r.text || '').split('\n').map(s => s.trim().replace(/^[-•\d.]+\s*/, '')).filter(Boolean).slice(0, 6);
    return steps.length ? steps : null;
  } catch { return null; }
}

async function selfReviewCode(reply, originalMessage, taskList) {
  if (!/```/.test(reply)) return reply;
  try {
    const taskNote = taskList?.length ? `\n\nخطة المهمة اللي كان المفروض تتنفذ:\n${taskList.map((t, i) => `${i + 1}. ${t}`).join('\n')}\nتأكد إن كل خطوة اتنفذت فعلًا في الرد، ولو خطوة اتنسيت أضفها.` : '';
    const r = await providerChat([
      { role: 'system', content: 'أنت مراجع كود صارم. افحص الرد التالي (اللي فيه كود) بدقة: bugs، edge cases ناقصة، أخطاء syntax، أو استخدام دوال/مكتبات غير موجودة فعليًا.' + taskNote + ' لو الكود سليم تمامًا زي ما هو والخطة كاملة، رجّع كلمة واحدة بس: OK. لو فيه مشكلة حقيقية أو خطوة ناقصة، رجّع الرد كامل بعد التصحيح بنفس التنسيق بالظبط، من غير ما تذكر إنك "راجعت" أو "صححت" حاجة — الرد النهائي بس.' },
      { role: 'user', content: `طلب المستخدم الأصلي: ${originalMessage}\n\nالرد اللي هيتراجع:\n${reply}` }
    ], 'barista-code');
    const t = (r.text || '').trim();
    if (!t || /^ok$/i.test(t)) return reply;
    return t;
  } catch { return reply; }
}

async function requireProject(ownerId, projectId) {
  return Project.findOne({ _id: projectId, ownerId }).lean();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  try {
    const actor = await requireUser(req);
    const b = await body(req);
    const message = String(b.message || '').trim();
    let model = String(b.model || 'barista-just');
    const projectId = b.projectId ? String(b.projectId) : null;
    const attachments = Array.isArray(b.attachments) ? b.attachments.slice(0, 4) : [];
    if (!message) return json(res, 400, { error: 'اكتب رسالة أولاً' });

    await db();

    let project = null;
    if (projectId) {
      project = await requireProject(actor.id, projectId);
      if (!project) return json(res, 404, { error: 'المشروع غير موجود' });
    }

    let u = await User.findOne({ clerkId: actor.id });
    if (!u) u = await User.create({ clerkId: actor.id, email: actor.email, displayName: actor.firstName || actor.email });

    const plan = activePlan(u);
    const p = PLANS[plan] || PLANS.free;

    // Barista Brain: resolve "auto" to a concrete model *before* the quota/weight
    // check below, so users are always charged for the model that actually ran.
    let routeReason = null;
    if (model === 'barista-auto') {
      const hasImage = attachments.some(a => a?.type === 'image');
      const decision = await classifyIntent(message, { hasAttachmentImage: hasImage, hasProjectFiles: !!projectId });
      model = decision.model;
      routeReason = decision.reason;
    }

    resetIfNeeded(u);
    const weight = MODEL_WEIGHT[model] || 2;
    if (p.daily !== Infinity && (u.dailyUsed || 0) + weight > p.daily) {
      return json(res, 429, { error: 'خلص رصيدك اليومي. الموديلات الأقوى تستهلك رصيدًا أكبر؛ جرّب موديلًا أخف أو فعّل Premium.' });
    }

    let c = b.chatId ? await Chat.findOne({ _id: b.chatId, ownerId: actor.id }) : null;
    if (!c) c = await Chat.create({ ownerId: actor.id, projectId, title: message.slice(0, 60) || 'محادثة جديدة', messages: [] });

    let result, reply, routeNote = '';
    if (model === 'barista-image') {
      const img = await providerImage(message);
      reply = `${img.text ? String(img.text).trim() + '\n\n' : ''}![صورة مولّدة بواسطة Barista](${img.url})`;
      result = { provider: img.provider, model: img.model };
    } else {
      await ensureSummary(c);
      const recent = c.messages.slice(c.summarizedCount).map(m => ({ role: m.role, content: m.content }));
      const memoryContext = await loadMemoryContext(actor.id, projectId);
      const files = model === 'barista-code' ? await relevantFiles(actor.id, projectId, message, 2) : [];
      const context = assembleContext({ projectInstructions: project?.instructions || '', memoryText: memoryContext, fileExcerpts: files });
      const baseSys = model === 'barista-code' ? CODE_SYSTEM : SYSTEM;
      const sysContent = baseSys
        + (context ? `\n\n${context}` : '')
        + (c.summary ? `\n\nملخص لأول المحادثة (أقدم من آخر الرسائل المعروضة هنا): ${c.summary}` : '');

      let convo = [{ role: 'system', content: sysContent }, ...recent, { role: 'user', content: message }];
      // barista-fast stays tool-free on purpose — it's the cheap/quick lane.
      const tools = model === 'barista-fast' ? null : toolsFor(model);

      // Agent Mode: only kicks in for barista-code inside a project (real files to
      // act on). Plans first, then gets a bigger tool-round budget to actually
      // execute the plan instead of stopping after one or two tool calls.
      const isAgentTask = model === 'barista-code' && !!projectId;
      const taskList = isAgentTask ? await planTasks(message) : null;
      if (taskList) convo[0].content += `\n\nخطة تنفيذ مقترحة لطلب المستخدم (نفّذها بالأدوات المتاحة فعليًا، خطوة بخطوة):\n${taskList.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
      const maxRounds = isAgentTask ? MAX_AGENT_TOOL_ROUNDS : MAX_TOOL_ROUNDS;

      result = await providerChat(convo, model, attachments, tools);

      const ctx = { message, sources: [], diffs: [], projectId, mode: model, chatId: String(c._id) };
      let rounds = 0;
      while (result.toolCalls?.length && rounds < maxRounds) {
        rounds++;
        convo.push({ role: 'assistant', content: result.text || null, tool_calls: result.toolCalls });
        for (const call of result.toolCalls.slice(0, 3)) {
          let toolResult;
          try {
            const args = JSON.parse(call.function?.arguments || '{}');
            toolResult = await runTool(actor, call.function?.name, args, ctx);
          } catch (e) { toolResult = `خطأ: ${e.message}`; }
          convo.push({ role: 'tool', tool_call_id: call.id, content: String(toolResult).slice(0, 4000) });
        }
        const hasMoreRounds = rounds < maxRounds;
        result = await providerChat(convo, model, [], hasMoreRounds ? tools : null);
      }

      reply = String(result.text || '').trim() || 'مقدرتش أطلع رد من الموديل دلوقتي. جرّب تاني.';

      if (model === 'barista-code') reply = await selfReviewCode(reply, message, taskList);

      if (taskList?.length) {
        reply = `**خطة التنفيذ:**\n${taskList.map(t => `- [x] ${t}`).join('\n')}\n\n---\n\n${reply}`;
      }
      if (ctx.sources.length) {
        const uniq = [...new Map(ctx.sources.map(s => [s.url, s])).values()].slice(0, 5);
        reply += '\n\n---\n**المصادر:**\n' + uniq.map((s, i) => `${i + 1}. [${s.title || s.url}](${s.url})`).join('\n');
      }
      if (ctx.diffs.length) {
        reply += '\n\n---\n**تعديلات الـ Workspace:**\n' + ctx.diffs.map(d => {
          if (d.action === 'create') return `📄 ملف جديد: \`${d.name}\``;
          if (d.action === 'delete') return `🗑️ اتحذف: \`${d.name}\``;
          if (d.action === 'rename') return `✏️ اتغيّر اسمه: \`${d.name}\``;
          return `✏️ \`${d.name}\`:\n\`\`\`diff\n${d.patch.slice(0, 2500)}\n\`\`\``;
        }).join('\n\n');
      }
    }

    c.messages.push({ role: 'user', content: message }, { role: 'assistant', content: reply, provider: result.provider, model: result.model });
    c.updatedAt = new Date();
    await c.save();
    u.dailyUsed = (u.dailyUsed || 0) + weight;
    await u.save();

    if (model !== 'barista-image') await extractMemory(actor.id, projectId, message);

    return json(res, 200, {
      chatId: c._id, reply, provider: result.provider, model: result.model, routedTo: routeReason ? model : undefined, plan,
      dailyUsed: u.dailyUsed, dailyLimit: p.daily === Infinity ? null : p.daily
    });
  } catch (e) {
    return json(res, e.status || 502, { error: e.message || 'تعذر الحصول على رد' });
  }
}
