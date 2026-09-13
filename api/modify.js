import { json, body, providerChat } from './_lib.js';
export default async function handler(req,res){
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 try{
  const b=await body(req); const name=String(b.name||'output.txt'); const content=String(b.content||''); const instruction=String(b.instruction||'عدّل الملف وحافظ على كل ما لا يحتاج تغييرًا.');
  if(!content)return json(res,400,{error:'الملف النصي فارغ أو لم يصل محتواه.'});
  if(content.length>1_200_000)return json(res,413,{error:'الملف كبير جدًا للمعالجة المباشرة. استخدم ملفًا أصغر في هذه النسخة.'});
  const r=await providerChat([{role:'system',content:'أنت Barista JUST. عند تعديل ملف، أعد محتوى الملف المعدل فقط بدون Markdown fences أو شرح خارجي.'},{role:'user',content:`اسم الملف: ${name}\nالمطلوب: ${instruction}\n\nمحتوى الملف:\n${content}`}],'barista-code');
  return json(res,200,{name,content:r.text,provider:r.provider,model:r.model});
 }catch(e){return json(res,502,{error:e.message||'تعذر تعديل الملف'});}
}
