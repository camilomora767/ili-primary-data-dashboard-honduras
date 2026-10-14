import { observationSurveyId } from '../lib/config.js';
import { exportResponses, isFinished, missing } from '../lib/qualtrics.js';
import { requireAccess } from '../lib/auth.js';

const ADMIN_ORDER = [
  'StartDate','EndDate','Status','IPAddress','Progress','Duration (in seconds)','Finished','RecordedDate','ResponseId',
  'RecipientLastName','RecipientFirstName','RecipientEmail','ExternalReference','LocationLatitude','LocationLongitude',
  'DistributionChannel','UserLanguage','Last Seen Flow Element ID','Last Seen Question IDs'
];

function naturalCompare(a,b) {
  return String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'});
}

function csvCell(value) {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

export default async function handler(req,res) {
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if (!requireAccess(req,res)) return;

  const token=process.env.QUALTRICS_API_TOKEN;
  const dataCenter=process.env.QUALTRICS_DATA_CENTER||'iad1';
  const surveyId=observationSurveyId();
  if (!token||!surveyId) return res.status(503).json({error:'Qualtrics environment variables are not configured'});

  try {
    const rows=(await exportResponses({dataCenter,surveyId,token})).filter(isFinished);
    const allCols=[...new Set(rows.flatMap(Object.keys))];
    const admin=ADMIN_ORDER.filter(c=>allCols.includes(c));
    const rest=allCols.filter(c=>!ADMIN_ORDER.includes(c)).sort(naturalCompare);
    const cols=[...admin,...rest];
    const date=new Date().toISOString().slice(0,10);

    res.statusCode=200;
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="ILI_Honduras_raw_observations_${date}.csv"`);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (typeof res.flushHeaders==='function') res.flushHeaders();

    // UTF-8 BOM helps Excel preserve accents and emoji.
    res.write('\uFEFF');
    res.write(cols.map(csvCell).join(',')+'\r\n');
    for (const row of rows) {
      res.write(cols.map(c=>csvCell(row[c])).join(',')+'\r\n');
    }
    res.end();
  } catch(e) {
    console.error(e);
    if (!res.headersSent) return res.status(502).json({error:'Unable to prepare raw CSV',detail:String(e?.message||e)});
    try{res.end();}catch{}
  }
}

