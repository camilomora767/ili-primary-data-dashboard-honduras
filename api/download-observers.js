import { tableWorkbookBuffer, XLSX_CONTENT_TYPE } from '../lib/excel.js';
export default async function handler(req,res) {
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  let rows;
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
    if(!Array.isArray(body?.rows)||!body.rows.length||body.rows.length>5000)throw new Error();
    rows=body.rows.map((row,index)=>{
      if(typeof row?.observer!=='string'||row.observer.length>500||!Number.isSafeInteger(row.count)||row.count<0)throw new Error();
      return [index+1,row.observer,row.count];
    });
  }catch{return res.status(400).json({error:'Invalid displayed observer rows'});}
  try{
    const buffer=await tableWorkbookBuffer({sheetName:'Observers',headers:['Rank','RecipientEmail','CompletedObservations'],rows});
    const date=new Date().toISOString().slice(0,10);
    res.statusCode=200;
    res.setHeader('Content-Type',XLSX_CONTENT_TYPE);
    res.setHeader('Content-Disposition','attachment; filename="ILI_Honduras_observations_by_observer_displayed_'+date+'.xlsx"');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Length',String(buffer.length));
    res.end(buffer);
  }catch(error){
    console.error(error);
    if(!res.headersSent)return res.status(502).json({error:'Unable to prepare observer workbook'});
    try{res.end();}catch{}
  }
}
