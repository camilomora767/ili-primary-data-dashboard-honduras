import { hasAccess, isProtected } from '../lib/auth.js';
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if(!isProtected()) return res.status(503).json({authenticated:false,protected:true,country:'Honduras',error:'Dashboard access code is not configured'});
  const authenticated=hasAccess(req);
  return res.status(authenticated?200:401).json({authenticated,protected:isProtected(),country:'Honduras'});
}

