import { db, User, json } from './_lib.js';
import { requireUser } from './auth.js';

const PLAN={free:{name:'Free',daily:25,maxFileMB:5,level:0},gpt:{name:'GPT',daily:100,maxFileMB:15,level:1},go:{name:'Go',daily:300,maxFileMB:30,level:2},plus:{name:'Plus',daily:1000,maxFileMB:80,level:3},god:{name:'God',daily:Infinity,maxFileMB:250,level:4}};
function activePlan(u){
  if(u.plan==='god' && u.unlimited) return 'god';
  if(u.premiumExpiresAt && new Date(u.premiumExpiresAt)>new Date()) return u.plan||'free';
  return 'free';
}
export {PLAN,activePlan};
export default async function handler(req,res){
  try{
    const user=await requireUser(req); await db();
    if(!db) return json(res,503,{error:'MongoDB غير مضبوط'});
    let doc=await User.findOne({clerkId:user.id});
    if(!doc) doc=await User.create({clerkId:user.id,email:user.email,displayName:[user.firstName,user.lastName].filter(Boolean).join(' ')||user.email});
    doc.email=user.email; doc.displayName=[user.firstName,user.lastName].filter(Boolean).join(' ')||doc.displayName; doc.imageUrl=user.imageUrl; await doc.save();
    const plan=activePlan(doc); const p=PLAN[plan];
    return json(res,200,{account:{id:doc.clerkId,email:doc.email,name:doc.displayName,imageUrl:doc.imageUrl,plan,planName:p.name,premiumExpiresAt:doc.unlimited?null:doc.premiumExpiresAt,unlimited:!!doc.unlimited,dailyLimit:p.daily===Infinity?null:p.daily,dailyUsed:doc.dailyUsed||0,maxFileMB:p.maxFileMB,redeemedCount:doc.redeemedCodes?.length||0}});
  }catch(e){return json(res,e.status||500,{error:e.message||'تعذر تحميل الحساب'});}
}
