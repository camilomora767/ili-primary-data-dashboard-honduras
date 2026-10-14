export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  return res.status(200).json({authenticated:true,protected:false,country:'Honduras'});
}

