import { json } from './_lib.js';
export default function handler(req,res){ return json(res,200,{ok:true,name:process.env.BARISTA_NAME||'Barista AI',version:'2.0.0'}); }
