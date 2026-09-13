import { db, Chat, json } from './_lib.js';
import { requireUser } from './auth.js';
export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
 try{const u=await requireUser(req);await db();const id=req.query?.id;const c=await Chat.findOne({_id:id,ownerId:u.id}).lean();if(!c)return json(res,404,{error:'المحادثة غير موجودة'});return json(res,200,{chat:c});}
 catch(e){return json(res,e.status||400,{error:'تعذر تحميل المحادثة'});}
}
