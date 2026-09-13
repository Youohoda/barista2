import { db, User, json, body } from './_lib.js';
import { requireUser } from './auth.js';
const CODE_PLANS={
 'Youseef.123':{random:['gpt','go'],months:1,label:'GPT أو Go لمدة شهر'},
 'Youseef.1203':{random:['gpt','go'],years:1,label:'GPT أو Go لمدة سنة'},
 '0110':{plan:'plus',months:1,label:'Plus لمدة شهر'},
 '01107':{plan:'plus',years:1,label:'Plus لمدة سنة'},
 'youohoda':{plan:'god',months:1,label:'God لمدة شهر'},
 'youohodaf':{plan:'god',years:1,label:'God لمدة سنة'},
 'y7':{plan:'god',unlimited:true,label:'كل البرميوم بلا نهاية'}
};
function addTime(base,cfg){const d=new Date(base&&new Date(base)>new Date()?base:new Date());if(cfg.years)d.setFullYear(d.getFullYear()+cfg.years);if(cfg.months)d.setMonth(d.getMonth()+cfg.months);return d;}
export default async function handler(req,res){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});try{const u=await requireUser(req),b=await body(req),code=String(b.code||'').trim(),cfg=CODE_PLANS[code];if(!cfg)return json(res,400,{error:'الكود غير صحيح أو غير موجود.'});await db();let doc=await User.findOne({clerkId:u.id});if(!doc && u.email)doc=await User.findOne({email:u.email.toLowerCase()});if(!doc)doc=await User.create({clerkId:u.id,email:u.email});else{doc.clerkId=u.id;doc.email=u.email.toLowerCase();}if((doc.redeemedCodes||[]).includes(code))return json(res,409,{error:'الكود ده اتستخدم بالفعل على الحساب ده.'});const plan=cfg.random?cfg.random[Math.floor(Math.random()*cfg.random.length)]:cfg.plan;if(cfg.unlimited){doc.plan='god';doc.unlimited=true;doc.premiumExpiresAt=null;}else{doc.plan=plan;doc.unlimited=false;doc.premiumExpiresAt=addTime(doc.premiumExpiresAt,cfg);}doc.redeemedCodes.push(code);await doc.save();return json(res,200,{ok:true,message:`تم تفعيل ${cfg.label}`,assignedPlan:plan,unlimited:!!doc.unlimited,premiumExpiresAt:doc.premiumExpiresAt});}catch(e){return json(res,e.status||500,{error:e.message||'تعذر تفعيل الكود'});}}
