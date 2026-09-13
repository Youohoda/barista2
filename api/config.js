import { json } from './_lib.js';
export default function handler(req,res){
  if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});
  return json(res,200,{publishableKey:process.env.CLERK_PUBLISHABLE_KEY||'',appName:process.env.BARISTA_NAME||'Barista AI'});
}
