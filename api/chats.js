// Chat list/create — scoped by project so the Projects switcher actually isolates
// conversations. projectId is read the same way on GET/POST: querystring on GET
// (?projectId=... or omitted/'' for the general workspace), body on POST. A chat's
// projectId is fixed at creation (never reassigned here), matching how chat.js
// already scopes messages, memory, and files to whichever project a chat belongs to.
import { db, Chat, json, body } from './_lib.js';
import { requireUser } from './auth.js';
export default async function handler(req,res){
 try{const u=await requireUser(req);await db();
  if(req.method==='GET'){
    const projectId = req.query?.projectId ? String(req.query.projectId) : null;
    const chats=await Chat.find({ownerId:u.id,projectId}).sort({updatedAt:-1}).limit(50).lean();
    return json(res,200,{chats});
  }
  if(req.method==='POST'){
    const b=await body(req);
    const projectId = b.projectId ? String(b.projectId) : null;
    const c=await Chat.create({ownerId:u.id,projectId,title:String(b.title||'محادثة جديدة').slice(0,100),messages:[]});
    return json(res,200,{chat:c});
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){return json(res,e.status||500,{error:e.message||'تعذر الوصول للمحادثات'});}
}
