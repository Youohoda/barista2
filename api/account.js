import { db, User, json, body } from './_lib.js';
import { requireUser } from './auth.js';

const PLAN={
  free:{name:'Free',daily:25,maxFileMB:5,level:0},
  gpt:{name:'GPT',daily:100,maxFileMB:15,level:1},
  go:{name:'Go',daily:300,maxFileMB:30,level:2},
  plus:{name:'Plus',daily:1000,maxFileMB:80,level:3},
  god:{name:'God',daily:Infinity,maxFileMB:250,level:4}
};
function activePlan(u){
  if(u.plan==='god' && u.unlimited) return 'god';
  if(u.premiumExpiresAt && new Date(u.premiumExpiresAt)>new Date()) return u.plan||'free';
  return 'free';
}
export {PLAN,activePlan};

export default async function handler(req,res){
  try{
    const actor=await requireUser(req); await db();
    let doc=await User.findOne({clerkId:actor.id});
    if(!doc) doc=await User.create({clerkId:actor.id,email:actor.email,displayName:[actor.firstName,actor.lastName].filter(Boolean).join(' ')||actor.email});

    if(req.method==='POST'){
      const b=await body(req);
      if(b.action==='reset-usage'){
        doc.dailyUsed=0; doc.dailyResetAt=new Date(); await doc.save();
        return json(res,200,{ok:true,dailyUsed:0});
      }
      return json(res,400,{error:'إجراء غير معروف'});
    }
    if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});

    doc.email=actor.email;
    doc.displayName=[actor.firstName,actor.lastName].filter(Boolean).join(' ')||doc.displayName;
    doc.imageUrl=actor.imageUrl;
    await doc.save();
    const plan=activePlan(doc), p=PLAN[plan];
    return json(res,200,{account:{
      id:doc.clerkId,email:doc.email,name:doc.displayName,imageUrl:doc.imageUrl,plan,planName:p.name,
      premiumExpiresAt:doc.unlimited?null:doc.premiumExpiresAt,unlimited:!!doc.unlimited,
      dailyLimit:p.daily===Infinity?null:p.daily,dailyUsed:doc.dailyUsed||0,maxFileMB:p.maxFileMB,
      redeemedCount:doc.redeemedCodes?.length||0
    }});
  }catch(e){return json(res,e.status||500,{error:e.message||'تعذر تحميل الحساب'});}
}
