import { db, Chat, json, body } from './_lib.js';
import { requireUser } from './auth.js';
export default async function handler(req,res){
 try{const u=await requireUser(req);await db();
  if(req.method==='GET'){const chats=await Chat.find({ownerId:u.id}).sort({updatedAt:-1}).limit(50).lean();return json(res,200,{chats});}
  if(req.method==='POST'){const b=await body(req);const c=await Chat.create({ownerId:u.id,title:String(b.title||'محادثة جديدة').slice(0,100),messages:[]});return json(res,200,{chat:c});}
  return json(res,405,{error:'Method not allowed'});
 }catch(e){return json(res,e.status||500,{error:e.message||'تعذر الوصول للمحادثات'});}
}
