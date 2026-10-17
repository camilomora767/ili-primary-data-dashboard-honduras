import { exportResponsesCsv, fetchExportFieldTypes } from '../lib/qualtrics.js';
import { courierSurveyId } from '../lib/config.js';
import { surveyWorkbookBuffer, XLSX_CONTENT_TYPE } from '../lib/excel.js';
export default async function handler(req,res) {
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const token=process.env.QUALTRICS_API_TOKEN;
  const dataCenter=process.env.QUALTRICS_DATA_CENTER||'iad1';
  const surveyId=courierSurveyId();
  if(!token||!surveyId)return res.status(503).json({error:'Courier survey environment variables are not configured'});
  try{
    // Legacy format query strings also receive XLSX; data downloads have one format.
    const [csv,fieldTypes]=await Promise.all([
      exportResponsesCsv({dataCenter,surveyId,token}),fetchExportFieldTypes({dataCenter,surveyId,token})
    ]);
    const buffer=await surveyWorkbookBuffer(csv,{sheetName:'Sheet0',fieldTypes});
    const date=new Date().toISOString().slice(0,10);
    res.statusCode=200;
    res.setHeader('Content-Type',XLSX_CONTENT_TYPE);
    res.setHeader('Content-Disposition','attachment; filename="ILI_Honduras_courier_survey_'+date+'.xlsx"');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Length',String(buffer.length));
    res.end(buffer);
  }catch(error){
    console.error(error);
    if(!res.headersSent)return res.status(502).json({error:'Unable to prepare Excel workbook',detail:String(error?.message||error)});
    try{res.end();}catch{}
  }
}
