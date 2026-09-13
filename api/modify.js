import { db, User, json, body, providerChat } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS, activePlan, resetIfNeeded } from './_plans.js';

const WEIGHT = 3; // same quota cost as barista-code in chat.js, since this hits the same model
export default async function handler(req,res){
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 try{
  const actor=await requireUser(req);
  await db();
  let u=await User.findOne({clerkId:actor.id});
  if(!u) u=await User.create({clerkId:actor.id,email:actor.email,displayName:actor.firstName||actor.email});
  const plan=activePlan(u);
  const p=PLANS[plan]||PLANS.free;
  resetIfNeeded(u);
  if(p.daily!==Infinity && (u.dailyUsed||0)+WEIGHT>p.daily){
    return json(res,429,{error:'خلص رصيدك اليومي. جرّب تاني بكرة أو فعّل Premium.'});
  }

  const b=await body(req); const name=String(b.name||'output.txt'); const content=String(b.content||''); const instruction=String(b.instruction||'عدّل الملف وحافظ على كل ما لا يحتاج تغييرًا.');
  if(!content)return json(res,400,{error:'الملف النصي فارغ أو لم يصل محتواه.'});
  const maxChars=Math.min(1_200_000, (p.maxFileMB||5)*1_000_000);
  if(content.length>maxChars)return json(res,413,{error:`الملف كبير جدًا لباقتك الحالية (${p.maxFileMB}MB). رقّي الباقة أو استخدم ملفًا أصغر.`});
  const r=await providerChat([{role:'system',content:'أنت Barista JUST. عند تعديل ملف، أعد محتوى الملف المعدل فقط بدون Markdown fences أو شرح خارجي.'},{role:'user',content:`اسم الملف: ${name}\nالمطلوب: ${instruction}\n\nمحتوى الملف:\n${content}`}],'barista-code');

  u.dailyUsed=(u.dailyUsed||0)+WEIGHT;
  await u.save();

  return json(res,200,{name,content:r.text,provider:r.provider,model:r.model,dailyUsed:u.dailyUsed,dailyLimit:p.daily===Infinity?null:p.daily});
 }catch(e){return json(res,e.status||502,{error:e.message||'تعذر تعديل الملف'});}
}
