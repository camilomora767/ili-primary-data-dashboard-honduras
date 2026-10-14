import { isProtected, setAccessCookie, validateCode } from '../lib/auth.js';

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  if(!isProtected()) return res.status(503).json({error:'Dashboard access code is not configured'});
  let body=req.body;
  if(typeof body==='string'){
    try{body=JSON.parse(body)}catch{body={}}
  }
  if(!validateCode(body?.code)) return res.status(401).json({error:'Invalid access code'});
  setAccessCookie(res);
  return res.status(200).json({ok:true,protected:true});
}

