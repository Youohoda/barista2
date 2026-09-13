import { json } from './_lib.js';
import { verifyToken } from '@clerk/backend';

function bearer(req){
  const h=req.headers?.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function clerkUser(userId){
  if(!process.env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is not configured');
  const r=await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,{headers:{Authorization:`Bearer ${process.env.CLERK_SECRET_KEY}`} });
  if(!r.ok) throw new Error('Unable to load account');
  return r.json();
}

export async function requireUser(req){
  const token=bearer(req);
  if(!token) throw Object.assign(new Error('LOGIN_REQUIRED'),{status:401});
  if(!process.env.CLERK_SECRET_KEY) throw Object.assign(new Error('CLERK_NOT_CONFIGURED'),{status:503});
  const payload=await verifyToken(token,{secretKey:process.env.CLERK_SECRET_KEY});
  const user=await clerkUser(payload.sub);
  const email=user.email_addresses?.find(x=>x.id===user.primary_email_address_id)?.email_address || user.email_addresses?.[0]?.email_address || '';
  return { id:payload.sub, email:email.toLowerCase(), firstName:user.first_name||'', lastName:user.last_name||'', imageUrl:user.image_url||'', user };
}

export async function optionalUser(req){
  try{return await requireUser(req)}catch{return null}
}

export default async function handler(req,res){
  if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});
  try{
    const user=await requireUser(req);
    return json(res,200,{authenticated:true,user:{id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,imageUrl:user.imageUrl}});
  }catch(e){return json(res,e.status||401,{authenticated:false,error:e.message==='LOGIN_REQUIRED'?'LOGIN_REQUIRED':e.message});}
}
