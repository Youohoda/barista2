import { json } from './_lib.js';
export default function handler(req,res){ return json(res,200,{models:[
 {id:'barista-just',name:'Barista JUST',description:'الموديل الرئيسي: يختار أفضل مسار متاح تلقائيًا'},
 {id:'barista-fast',name:'Barista Fast',description:'أسرع ردود للمحادثات اليومية'},
 {id:'barista-code',name:'Barista Code',description:'برمجة وتصحيح وبناء المشاريع'},
 {id:'barista-reasoning',name:'Barista Reasoning',description:'تحليل ومسائل متعددة الخطوات'}
]}); }
