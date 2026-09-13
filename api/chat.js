import { db, Chat, User, json, body, providerChat } from './_lib.js';
import { requireUser } from './auth.js';

const PLANS={free:{daily:25,level:0},gpt:{daily:100,level:1},go:{daily:300,level:2},plus:{daily:1000,level:3},god:{daily:Infinity,level:4}};
const MODEL_LEVEL={'barista-fast':0,'barista-just':1,'barista-code':2,'barista-reasoning':3};
const SYSTEM=`أنت Barista JUST، المساعد الرئيسي في Barista AI. أجب بالعربية أو بلغة المستخدم. كن دقيقًا ومفيدًا وطبيعيًا. لا تدّعِ أنك نفذت شيئًا لم تنفذه. عند البرمجة أعطِ حلولًا قابلة للتنفيذ، ونسّق الكود بوضوح. إذا كان المستخدم يريد ملفًا، وضّح ما يمكنك إنشاؤه أو تعديله داخل النظام.`;
function activePlan(u){if(u.unlimited&&u.plan==='god')return'god';if(u.premiumExpiresAt&&new Date(u.premiumExpiresAt)>new Date())return u.plan||'free';return'free';}
function resetIfNeeded(u){const now=new Date(), last=new Date(u.dailyResetAt||0);if(now.toDateString()!==last.toDateString()){u.dailyUsed=0;u.dailyResetAt=now;}}
export default async function handler(req,res){
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 try{
  const actor=await requireUser(req); const b=await body(req); const message=String(b.message||'').trim(); const model=String(b.model||'barista-just'); const attachments=Array.isArray(b.attachments)?b.attachments.slice(0,4):[];
  if(!message)return json(res,400,{error:'اكتب رسالة أولاً'});
  await db(); let u=await User.findOne({clerkId:actor.id}); if(!u)u=await User.create({clerkId:actor.id,email:actor.email,displayName:actor.firstName||actor.email});
  const plan=activePlan(u); const p=PLANS[plan]||PLANS.free; resetIfNeeded(u);
  if(MODEL_LEVEL[model]>p.level)return json(res,403,{error:`موديل ${model} متاح من باقة أعلى. باقتك الحالية: ${plan}.`});
  if(p.daily!==Infinity && u.dailyUsed>=p.daily)return json(res,429,{error:'خلصت حصتك اليومية. فعّل باقة أعلى أو استخدم كود Premium.'});
  let c=b.chatId?await Chat.findOne({_id:b.chatId,ownerId:actor.id}):null; if(!c)c=await Chat.create({ownerId:actor.id,title:message.slice(0,60),messages:[]});
  const history=c.messages.slice(-18).map(m=>({role:m.role,content:m.content}));
  const result=await providerChat([{role:'system',content:SYSTEM},...history,{role:'user',content:message}],model,attachments);
  c.messages.push({role:'user',content:message},{role:'assistant',content:result.text,provider:result.provider,model:result.model}); c.updatedAt=new Date(); await c.save();
  u.dailyUsed=(u.dailyUsed||0)+1; await u.save();
  return json(res,200,{chatId:c._id,reply:result.text,provider:result.provider,model:result.model,plan,dailyUsed:u.dailyUsed,dailyLimit:p.daily===Infinity?null:p.daily});
 }catch(e){return json(res,e.status||502,{error:e.message||'تعذر الحصول على رد'});}
}
