import mongoose from 'mongoose';
import { db, User, WorkspaceFile, json, body, providerChat } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS, activePlan, resetIfNeeded } from './_plans.js';
import { computeStats } from './_data-analyst.js';

const HARD_MAX = 5_500_000; // absolute ceiling regardless of plan, so one request can't blow up memory
const textExt = /\.(txt|md|json|js|ts|tsx|jsx|css|html|py|java|c|cpp|h|hpp|php|sql|sh|yml|yaml|xml|csv|log|env|ini|toml|vue|svelte|astro|rs|go|rb|swift|kt|dart|lua|r|bat|ps1|graphql|svg)$/i;

function b64ToBuffer(b64, maxBytes){
  const raw=String(b64||'').replace(/^data:[^;]+;base64,/,'');
  const buf=Buffer.from(raw,'base64');
  if(buf.length>maxBytes) throw Object.assign(new Error(`الملف أكبر من الحد المسموح لباقتك (${(maxBytes/1_000_000).toFixed(0)}MB). رقّي الباقة لرفع ملفات أكبر.`),{status:413});
  return buf;
}

async function extract(b, maxBytes){
  const name=String(b.name||'file');
  const mime=String(b.mime||'application/octet-stream');
  if(typeof b.text==='string') return b.text.slice(0,350000);
  if(!b.data) return '';
  const buf=b64ToBuffer(b.data, maxBytes);
  if(mime.startsWith('text/') || textExt.test(name)) return buf.toString('utf8').slice(0,350000);
  if(mime==='application/pdf' || /\.pdf$/i.test(name)) {
    const mod=await import('pdf-parse');
    const fn=mod.default||mod;
    const out=await fn(buf);
    return String(out.text||'').slice(0,350000);
  }
  if(mime.includes('wordprocessingml') || /\.docx$/i.test(name)) {
    const mammoth=await import('mammoth');
    const out=await mammoth.extractRawText({buffer:buf});
    return String(out.value||'').slice(0,350000);
  }
  if(mime.includes('spreadsheetml') || /\.(xlsx|xls)$/i.test(name)) {
    const XLSX=await import('xlsx');
    const wb=XLSX.read(buf,{type:'buffer'});
    return wb.SheetNames.map(n=>`=== Sheet: ${n} ===\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n').slice(0,350000);
  }
  return '';
}

const imageExt = /\.(png|jpe?g|webp|gif|bmp)$/i;
function isImage(b) { return String(b.mime || '').startsWith('image/') || imageExt.test(String(b.name || '')); }

// File analysis calls the AI model just like chat.js does, so it must count against the
// same daily quota and respect the same per-plan file-size cap — otherwise it's a free,
// unlimited side door around the whole plan system regardless of what the user is paying for.
const WEIGHT = 3;

async function chargeAndLoadUser(actor){
  await db();
  let u=await User.findOne({clerkId:actor.id});
  if(!u) u=await User.create({clerkId:actor.id,email:actor.email,displayName:actor.firstName||actor.email});
  const plan=activePlan(u);
  const p=PLANS[plan]||PLANS.free;
  resetIfNeeded(u);
  if(p.daily!==Infinity && (u.dailyUsed||0)+WEIGHT>p.daily){
    throw Object.assign(new Error('خلص رصيدك اليومي. جرّب تاني بكرة أو فعّل Premium.'),{status:429});
  }
  return {u,p};
}

// Vision + OCR, integrated into File Intelligence rather than a separate system:
// images go through the same multimodal path chat.js already uses for attachments
// (providerChat's openrouter branch), so "OCR"/"read this screenshot" is a real
// model call on the real image bytes, not a stub. Extracted text is cached in
// WorkspaceFile.content exactly like every other file type, so it becomes
// searchable/comparable afterwards without re-uploading or re-running vision.
async function analyzeImage(actor, b, instruction, maxBytes) {
  const buf = b64ToBuffer(b.data, maxBytes);
  const mime = String(b.mime || 'image/png');
  const dataUrl = b.data.startsWith('data:') ? b.data : `data:${mime};base64,${buf.toString('base64')}`;
  const r = await providerChat([
    { role: 'system', content: 'أنت Barista Vision. عندك صورة حقيقية مرفقة (سكرين شوت، مستند، رسم بياني، أو جدول داخل صورة). حلل محتواها الفعلي فقط، واستخرج أي نص موجود بدقة (OCR) لو المطلوب كده. لا تخترع محتوى غير موجود في الصورة.' },
    { role: 'user', content: instruction }
  ], 'barista-just', [{ type: 'image', dataUrl }]);
  return r;
}

async function actionAnalyze(actor,b){
  const {u,p}=await chargeAndLoadUser(actor);
  const maxBytes=Math.min(HARD_MAX, p.maxFileMB*1_000_000);
  const name=String(b.name||'file'); const instruction=String(b.instruction||'اقرأ الملف، افهمه، ونفذ المطلوب بدقة.');
  const projectId = b.projectId ? String(b.projectId) : null; // null = general workspace, unchanged default behavior

  if (isImage(b) && b.data) {
    const vis = await analyzeImage(actor, b, instruction, maxBytes);
    // Cache the model's extracted description/OCR text as the file's searchable
    // content — real content from a real call, not the raw image bytes re-encoded.
    await WorkspaceFile.findOneAndUpdate(
      { ownerId: actor.id, projectId, name },
      { ownerId: actor.id, projectId, name, mime: String(b.mime||'image/png'), content: vis.text || '', size: (vis.text||'').length, createdAt: new Date() },
      { upsert: true }
    );
    u.dailyUsed=(u.dailyUsed||0)+WEIGHT; await u.save();
    return { readable:true, name, result: vis.text||'', provider: vis.provider, model: vis.model, kind: 'image', dailyUsed:u.dailyUsed, dailyLimit:p.daily===Infinity?null:p.daily };
  }

  const content=await extract(b, maxBytes);
  if(!content) return {readable:false,name,message:'تم استلام الملف. هذا الامتداد لا يمكن استخراج محتواه داخل بيئة المتصفح/الخادم الحالية، لكن يمكن تنزيل النسخة الأصلية.'};

  // Persist so it's searchable / comparable later without re-uploading.
  await WorkspaceFile.findOneAndUpdate(
    { ownerId: actor.id, projectId, name },
    { ownerId: actor.id, projectId, name, mime: String(b.mime||''), content, size: content.length, createdAt: new Date() },
    { upsert: true }
  );

  const r=await providerChat([
    {role:'system',content:'أنت Barista AI. تعامل مع الملف المرفق كملف حقيقي. لا تخترع محتوى غير موجود. نفذ طلب المستخدم على المحتوى المتاح. إذا كان المطلوب تعديل ملف نصي أو كود، أعد الملف كاملًا فقط بدون Markdown fences. إذا كان المطلوب تحليلًا، أعد تحليلًا واضحًا ودقيقًا.'},
    {role:'user',content:`اسم الملف: ${name}\nالمطلوب: ${instruction}\n\nمحتوى الملف:\n${content}`}
  ],'barista-just');

  u.dailyUsed=(u.dailyUsed||0)+WEIGHT;
  await u.save();
  return {readable:true,name,result:r.text||'',provider:r.provider,model:r.model,dailyUsed:u.dailyUsed,dailyLimit:p.daily===Infinity?null:p.daily};
}

async function actionCompare(actor,b){
  const {u,p}=await chargeAndLoadUser(actor);
  const nameA=String(b.nameA||''), nameB=String(b.nameB||'');
  const instruction=String(b.instruction||'قارن الملفين واستخرج أهم الفروقات بدقة.');
  const projectId = b.projectId ? String(b.projectId) : null;
  const [fa,fb]=await Promise.all([
    WorkspaceFile.findOne({ownerId:actor.id,projectId,name:nameA}).lean(),
    WorkspaceFile.findOne({ownerId:actor.id,projectId,name:nameB}).lean()
  ]);
  if(!fa||!fb) throw Object.assign(new Error('لازم الملفين يتحللوا أولاً (analyze) قبل المقارنة.'),{status:404});

  const r=await providerChat([
    {role:'system',content:'أنت Barista AI. عندك ملفين حقيقيين. نفذ طلب المستخدم على أساس المقارنة بينهم فقط، ووضح الفروقات الجوهرية (مش مجرد اختلافات شكلية) بنقاط واضحة.'},
    {role:'user',content:`الملف الأول (${fa.name}):\n${fa.content.slice(0,150000)}\n\n---\n\nالملف الثاني (${fb.name}):\n${fb.content.slice(0,150000)}\n\nالمطلوب: ${instruction}`}
  ],'barista-just');

  u.dailyUsed=(u.dailyUsed||0)+WEIGHT;
  await u.save();
  return {result:r.text||'',provider:r.provider,model:r.model,dailyUsed:u.dailyUsed,dailyLimit:p.daily===Infinity?null:p.daily};
}

// Data Analyst: real column detection/stats/correlation/outliers computed in pure
// JS (see _data-analyst.js) over a CSV file already extracted into WorkspaceFile —
// no model call, no quota charge, and no Python execution on the production host.
async function actionStats(actor, b) {
  await db();
  const name = String(b.name || '');
  const projectId = b.projectId ? String(b.projectId) : null;
  const f = await WorkspaceFile.findOne({ ownerId: actor.id, projectId, name }).lean();
  if (!f) throw Object.assign(new Error('لازم الملف يتحلل (analyze) أولاً قبل ما تطلب Stats.'), { status: 404 });
  const stats = computeStats(f.content);
  return { name, ...stats };
}

// Plain substring search across everything the user has uploaded — no model call,
// no quota charge, just a fast local lookup with a snippet of context per hit.
async function actionSearch(actor,q,projectId){
  await db();
  const files=await WorkspaceFile.find({ownerId:actor.id,projectId:projectId||null}).select('name content').lean();
  const needle=q.toLowerCase();
  const hits=[];
  for(const f of files){
    const idx=f.content.toLowerCase().indexOf(needle);
    if(idx===-1) continue;
    const start=Math.max(0,idx-80);
    hits.push({name:f.name,snippet:(start>0?'…':'')+f.content.slice(start,idx+needle.length+80)+'…'});
  }
  return {query:q,hits};
}

export default async function handler(req,res){
 try{
  const actor=await requireUser(req);

  if(req.method==='GET'){
    await db();
    const q=req.query?.q;
    const projectId=req.query?.projectId?String(req.query.projectId):null;
    if(q) return json(res,200,await actionSearch(actor,String(q),projectId));
    const files=await WorkspaceFile.find({ownerId:actor.id,projectId}).select('name mime size createdAt').sort({createdAt:-1}).lean();
    return json(res,200,{files:files.map(f=>({name:f.name,mime:f.mime,size:f.size,createdAt:f.createdAt}))});
  }

  if(req.method==='DELETE'){
    await db();
    const name=req.query?.name;
    const projectId=req.query?.projectId?String(req.query.projectId):null;
    if(name==='all'){ await WorkspaceFile.deleteMany({ownerId:actor.id,projectId}); return json(res,200,{ok:true}); }
    if(!name) return json(res,400,{error:'اسم الملف مطلوب'});
    await WorkspaceFile.deleteOne({ownerId:actor.id,projectId,name});
    return json(res,200,{ok:true});
  }

  if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
  const b=await body(req);
  const action=String(b.action||'analyze');
  if(action==='compare') return json(res,200,await actionCompare(actor,b));
  if(action==='stats') return json(res,200,await actionStats(actor,b));
  return json(res,200,await actionAnalyze(actor,b));
 }catch(e){ return json(res,e.status||502,{error:e.message||'تعذر معالجة الملف'}); }
}
