import { db, User, json, body } from './_lib.js';
import { requireUser } from './auth.js';
const OWNER_EMAIL=(process.env.BARISTA_OWNER_EMAIL||'yousefhoda15@gmail.com').trim().toLowerCase();
function owner(u){return !!OWNER_EMAIL&&u.email===OWNER_EMAIL;}
const ALL_CODES=['Youseef.123','Youseef.1203','0110','01107','youohoda','youohodaf','y7'];
export default async function handler(req,res){
 try{const u=await requireUser(req);if(!owner(u))return json(res,403,{error:'OWNER_ONLY'});await db();
  if(req.method==='GET'){const users=await User.find().sort({createdAt:-1}).limit(100).lean();return json(res,200,{owner:true,codes:ALL_CODES,users:users.map(x=>({email:x.email,plan:x.unlimited?'god':x.plan||'free',unlimited:!!x.unlimited,premiumExpiresAt:x.premiumExpiresAt,dailyUsed:x.dailyUsed||0,createdAt:x.createdAt}))});}
  if(req.method==='POST'){const b=await body(req),action=String(b.action||'');
   if(action==='grant'){const email=String(b.email||'').trim().toLowerCase(),plan=String(b.plan||'gpt'),duration=String(b.duration||'month');if(!email||!['gpt','go','plus','god'].includes(plan))return json(res,400,{error:'بيانات غير صحيحة'});let doc=await User.findOne({email});if(!doc)doc=await User.create({email});if(duration==='forever'){doc.plan=plan;doc.unlimited=true;doc.premiumExpiresAt=null;}else{const d=new Date();if(duration==='year')d.setFullYear(d.getFullYear()+1);else d.setMonth(d.getMonth()+1);doc.plan=plan;doc.unlimited=false;doc.premiumExpiresAt=d;}await doc.save();return json(res,200,{ok:true});}
   if(action==='remove'){const email=String(b.email||'').trim().toLowerCase(),doc=await User.findOne({email});if(!doc)return json(res,404,{error:'الحساب غير موجود'});doc.plan='free';doc.unlimited=false;doc.premiumExpiresAt=null;await doc.save();return json(res,200,{ok:true});}
   if(action==='reset-limit'){const email=String(b.email||'').trim().toLowerCase(),doc=await User.findOne({email});if(!doc)return json(res,404,{error:'الحساب غير موجود'});doc.dailyUsed=0;doc.dailyResetAt=new Date();await doc.save();return json(res,200,{ok:true});}
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){return json(res,e.status||500,{error:e.message||'تعذر فتح نظام السري'});}
}
