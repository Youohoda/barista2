import { json, body, providerChat } from './_lib.js';
import { requireUser } from './auth.js';

const MAX = 5_500_000;
const textExt = /\.(txt|md|json|js|ts|tsx|jsx|css|html|py|java|c|cpp|h|hpp|php|sql|sh|yml|yaml|xml|csv|log|env|ini|toml|vue|svelte|astro|rs|go|rb|swift|kt|dart|lua|r|bat|ps1|graphql|svg)$/i;

function b64ToBuffer(b64){
  const raw=String(b64||'').replace(/^data:[^;]+;base64,/,'');
  const buf=Buffer.from(raw,'base64');
  if(buf.length>MAX) throw Object.assign(new Error('الملف أكبر من الحد المسموح للمعالجة.'),{status:413});
  return buf;
}

async function extract(b){
  const name=String(b.name||'file');
  const mime=String(b.mime||'application/octet-stream');
  if(typeof b.text==='string') return b.text.slice(0,350000);
  if(!b.data) return '';
  const buf=b64ToBuffer(b.data);
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

export default async function handler(req,res){
 if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
 try{
  await requireUser(req);
  const b=await body(req); const name=String(b.name||'file'); const instruction=String(b.instruction||'اقرأ الملف، افهمه، ونفذ المطلوب بدقة.');
  const content=await extract(b);
  if(!content) return json(res,200,{readable:false,name,message:'تم استلام الملف. هذا الامتداد لا يمكن استخراج محتواه داخل بيئة المتصفح/الخادم الحالية، لكن يمكن تنزيل النسخة الأصلية.'});
  const r=await providerChat([
    {role:'system',content:'أنت Barista AI. تعامل مع الملف المرفق كملف حقيقي. لا تخترع محتوى غير موجود. نفذ طلب المستخدم على المحتوى المتاح. إذا كان المطلوب تعديل ملف نصي أو كود، أعد الملف كاملًا فقط بدون Markdown fences. إذا كان المطلوب تحليلًا، أعد تحليلًا واضحًا ودقيقًا.'},
    {role:'user',content:`اسم الملف: ${name}\nالمطلوب: ${instruction}\n\nمحتوى الملف:\n${content}`}
  ],'barista-just');
  return json(res,200,{readable:true,name,result:r.text||'',provider:r.provider,model:r.model});
 }catch(e){ return json(res,e.status||502,{error:e.message||'تعذر معالجة الملف'}); }
}
