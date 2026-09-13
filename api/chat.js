import { db, Chat, User, json, body, providerChat } from './_lib.js';
import { requireUser } from './auth.js';

const PLANS={free:{daily:25,level:0},gpt:{daily:100,level:1},go:{daily:300,level:2},plus:{daily:1000,level:3},god:{daily:Infinity,level:4}};
const MODEL_LEVEL={'barista-fast':0,'barista-just':1,'barista-code':2,'barista-reasoning':3};
const SYSTEM=`أنت Barista AI، مساعد ذكي عام داخل تطبيق Barista AI. أجب بلغة المستخدم وباتجاه كتابة صحيح. كن دقيقًا ولا تخترع معلومات أو نتائج أو تنفيذات لم تحدث. إذا لم تكن متأكدًا قل ذلك بوضوح. عند البرمجة أعطِ كودًا عمليًا كاملًا قدر الإمكان، وحافظ على سياق المشروع. إذا أرسل المستخدم صورة فحللها فعليًا إذا كان الموديل يدعم الرؤية. إذا أرسل ملفًا، استخدم محتواه عندما يكون متاحًا ولا تدّعِ قراءة ملف لم يصل محتواه. لا تكشف مفاتيح API أو أسرار الخادم.`;
function activePlan(u){if(u.unlimited&&u.plan==='god')return'god';if(u.premiumExpiresAt&&new Date(u.premiumExpiresAt)>new Date())return u.plan||'free';return'free';}
function resetIfNeeded(u){const now=new Date(),last=new Date(u.dailyResetAt||0);if(now.toDateString()!==last.toDateString()){u.dailyUsed=0;u.dailyResetAt=now;}}

export default async function handler(req,res){
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 try{
  const actor=await requireUser(req); const b=await body(req);
  const message=String(b.message||'').trim(); const model=String(b.model||'barista-just');
  const attachments=Array.isArray(b.attachments)?b.attachments.slice(0,4):[];
  if(!message)return json(res,400,{error:'اكتب رسالة أولاً'});
  await db(); let u=await User.findOne({clerkId:actor.id});
  if(!u)u=await User.create({clerkId:actor.id,email:actor.email,displayName:actor.firstName||actor.email});
  const plan=activePlan(u),p=PLANS[plan]||PLANS.free; resetIfNeeded(u);
  if(MODEL_LEVEL[model]>p.level)return json(res,403,{error:`موديل ${model} يحتاج باقة أعلى. باقتك الحالية ${plan}.`});
  if(p.daily!==Infinity && u.dailyUsed>=p.daily)return json(res,429,{error:'خلصت حصتك اليومية. فعّل Premium أو استخدم موديل متاح لباقتك.'});
  let c=b.chatId?await Chat.findOne({_id:b.chatId,ownerId:actor.id}):null;
  if(!c)c=await Chat.create({ownerId:actor.id,title:message.slice(0,60)||'محادثة جديدة',messages:[]});
  const history=c.messages.slice(-18).map(m=>({role:m.role,content:m.content}));
  const result=await providerChat([{role:'system',content:SYSTEM},...history,{role:'user',content:message}],model,attachments);
  const reply=String(result.text||'').trim()||'مقدرتش أطلع رد من الموديل دلوقتي. جرّب تاني.';
  c.messages.push({role:'user',content:message},{role:'assistant',content:reply,provider:result.provider,model:result.model});
  c.updatedAt=new Date(); await c.save();
  u.dailyUsed=(u.dailyUsed||0)+1; await u.save();
  return json(res,200,{chatId:c._id,reply,provider:result.provider,model:result.model,plan,dailyUsed:u.dailyUsed,dailyLimit:p.daily===Infinity?null:p.daily});
 }catch(e){return json(res,e.status||502,{error:e.message||'تعذر الحصول على رد'});}
}
