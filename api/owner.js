import { db, User, Gift, json, body } from './_lib.js';
import { requireUser } from './auth.js';
const OWNER_EMAIL=(process.env.BARISTA_OWNER_EMAIL||'yousefhoda15@gmail.com').trim().toLowerCase();
function owner(u){return !!OWNER_EMAIL&&u.email===OWNER_EMAIL;}
const ALL_CODES=['Youseef.123','Youseef.1203','0110','01107','youohoda','youohodaf','y7'];

export default async function handler(req,res){
 try{
  const u=await requireUser(req);
  if(!owner(u)) return json(res,403,{error:'OWNER_ONLY'});
  await db();
  if(req.method==='GET'){
   const users=await User.find().sort({createdAt:-1}).limit(100).lean();
   const gifts=await Gift.find().sort({createdAt:-1}).limit(50).lean();
   return json(res,200,{owner:true,ownerEmail:OWNER_EMAIL,codes:ALL_CODES,
    users:users.map(x=>({email:x.email,plan:x.unlimited?'god':x.plan||'free',unlimited:!!x.unlimited,premiumExpiresAt:x.premiumExpiresAt,dailyUsed:x.dailyUsed||0,createdAt:x.createdAt})),
    gifts:gifts.map(g=>({id:String(g._id),name:g.name,target:g.target,email:g.email,country:g.country,plan:g.plan,durationValue:g.durationValue,durationUnit:g.durationUnit,startsAt:g.startsAt,endsAt:g.endsAt,active:g.active,maxClaims:g.maxClaims,claims:g.claims}))
   });
  }
  if(req.method==='POST'){
   const b=await body(req),action=String(b.action||'');
   if(action==='grant'){
    const email=String(b.email||'').trim().toLowerCase(),plan=String(b.plan||'gpt'),duration=String(b.duration||'month');
    if(!email||!['gpt','go','plus','god'].includes(plan))return json(res,400,{error:'بيانات غير صحيحة'});
    let doc=await User.findOne({email});
    if(!doc)doc=await User.create({email});
    if(duration==='forever'){doc.plan=plan;doc.unlimited=true;doc.premiumExpiresAt=null;}
    else{const d=new Date();if(duration==='year')d.setFullYear(d.getFullYear()+1);else d.setMonth(d.getMonth()+1);doc.plan=plan;doc.unlimited=false;doc.premiumExpiresAt=d;}
    await doc.save();return json(res,200,{ok:true});
   }
   if(action==='create-gift'){
    const target=['user','all','country'].includes(String(b.target))?String(b.target):'user';
    const plan=String(b.plan||'gpt'), value=Math.floor(Number(b.durationValue||1)), unit=String(b.durationUnit||'days');
    if(!['gpt','go','plus','god'].includes(plan)||!Number.isFinite(value)||value<1||value>3650||!['days','weeks','months','years'].includes(unit)) return json(res,400,{error:'بيانات الهدية غير صحيحة'});
    const email=String(b.email||'').trim().toLowerCase();
    const country=String(b.country||'').trim().toUpperCase();
    if(target==='user'&&!email)return json(res,400,{error:'اكتب إيميل الشخص'});
    if(target==='country'&&!/^[A-Z]{2}$/.test(country))return json(res,400,{error:'اكتب كود الدولة من حرفين مثل EG'});
    const gift=await Gift.create({name:String(b.name||'هدية Barista').slice(0,80),target,email:target==='user'?email:undefined,country:target==='country'?country:undefined,plan,durationValue:value,durationUnit:unit,maxClaims:Math.max(0,Math.floor(Number(b.maxClaims||0))),active:true});
    return json(res,200,{ok:true,gift:{id:String(gift._id)}});
   }
   if(action==='toggle-gift'){
    const id=String(b.id||''),gift=await Gift.findById(id);if(!gift)return json(res,404,{error:'الهدية غير موجودة'});
    gift.active=!gift.active;await gift.save();return json(res,200,{ok:true,active:gift.active});
   }
   if(action==='delete-gift'){
    const id=String(b.id||'');const r=await Gift.deleteOne({_id:id});if(!r.deletedCount)return json(res,404,{error:'الهدية غير موجودة'});return json(res,200,{ok:true});
   }
   if(action==='remove'){
    const email=String(b.email||'').trim().toLowerCase(),doc=await User.findOne({email});if(!doc)return json(res,404,{error:'الحساب غير موجود'});doc.plan='free';doc.unlimited=false;doc.premiumExpiresAt=null;await doc.save();return json(res,200,{ok:true});
   }
   if(action==='reset-limit'){
    const email=String(b.email||'').trim().toLowerCase(),doc=await User.findOne({email});if(!doc)return json(res,404,{error:'الحساب غير موجود'});doc.dailyUsed=0;doc.dailyResetAt=new Date();await doc.save();return json(res,200,{ok:true});
   }
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){return json(res,e.status||500,{error:e.message||'تعذر فتح نظام السري'});}
}
