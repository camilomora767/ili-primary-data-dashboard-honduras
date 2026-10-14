import { courierSurveyId } from '../lib/config.js';
import { exportResponses, isFinished, missing } from '../lib/qualtrics.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const token=process.env.QUALTRICS_API_TOKEN;
  const dataCenter=process.env.QUALTRICS_DATA_CENTER||'iad1';
  const surveyId=courierSurveyId();
  if (!token||!surveyId) return res.status(503).json({error:'Courier survey environment variables are not configured'});

  try {
    const rows=(await exportResponses({dataCenter,surveyId,token})).filter(isFinished);
    const linked=rows.filter(r=>!missing(r.ObservationID)).length;
    const uniqueLinked=new Set(rows.map(r=>String(r.ObservationID||'').trim()).filter(Boolean)).size;
    const institutions=[...new Set(rows.map(r=>String(r.Institution||'').trim()).filter(Boolean))].sort();
    return res.status(200).json({
      mode:'live',
      generatedAt:new Date().toISOString(),
      surveyId,
      summary:{
        responses:rows.length,
        linkedResponses:linked,
        uniqueObservationIds:uniqueLinked,
        linkRate:rows.length?Math.round(1000*linked/rows.length)/10:0,
        institutions:institutions.length
      }
    });
  } catch(e) {
    console.error(e);
    return res.status(502).json({error:'Unable to load courier survey data',detail:String(e?.message||e)});
  }
}

