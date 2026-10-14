import { observationSurveyId, operationQuestionId, vehicleQuestionId, photoValue } from '../lib/config.js';
import { exportResponses, fetchSurveyMetadata, isFinished, missing, num } from '../lib/qualtrics.js';
import { requireAccess } from '../lib/auth.js';

const ADMIN = new Set([
  'StartDate','EndDate','Status','IPAddress','Progress','Duration (in seconds)','Finished',
  'RecordedDate','ResponseId','RecipientLastName','RecipientFirstName','RecipientEmail',
  'ExternalReference','LocationLatitude','LocationLongitude','DistributionChannel','UserLanguage',
  'Last Seen Flow Element ID','Last Seen Question IDs'
]);

const median = a => {
  const x = a.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!x.length) return null;
  const m = Math.floor(x.length/2);
  return x.length % 2 ? x[m] : (x[m-1]+x[m])/2;
};

function bins(values, edges, labels) {
  const out = Array(labels.length).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let i = edges.findIndex(e => v <= e);
    if (i < 0) i = labels.length - 1;
    out[i]++;
  }
  return { labels, values:out };
}

function get(r, ...keys) {
  for (const k of keys) if (!missing(r[k])) return r[k];
  return null;
}

function baseQuestionId(col) {
  const m = String(col).match(/^(QID\d+)$/i);
  return m ? m[1].toUpperCase() : null;
}

function resolveChoice(value, meta) {
  if (missing(value)) return null;
  const text = String(value).trim();
  const choices = meta?.choices || {};
  const mapOne = part => {
    const p = String(part).trim();
    return choices[p] || p;
  };
  if (meta?.multi) {
    return text.split(/\s*[;,]\s*/).map(mapOne).filter(Boolean).join('; ');
  }
  return mapOne(text);
}

function categoricalItems(values, meta) {
  const counts = {};
  let denominator = 0;
  for (const raw of values) {
    const resolved = resolveChoice(raw, meta);
    if (missing(resolved)) continue;
    denominator++;
    const parts = meta?.multi ? String(resolved).split(/\s*;\s*/) : [String(resolved)];
    for (const part of parts) if (part) counts[part] = (counts[part] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,6)
    .map(([k,n])=>[k, denominator ? Math.round(1000*n/denominator)/10 : 0]);
}

function operationalQuality(rows, points, dwellAll) {
  const n = Math.max(rows.length,1);
  const hasEmail = rows.filter(r=>!missing(r.RecipientEmail)).length;
  const hasRef = rows.filter(r=>!missing(r.ExternalReference)).length;
  const hasPhoto = rows.filter(r=>!missing(photoValue(r,'id'))).length;
  const hasDuration = rows.filter(r=>Number.isFinite(num(r['Duration (in seconds)']))).length;
  const usableDwell = dwellAll.filter(v=>Number.isFinite(v)&&v>=0&&v<=30).length;
  return [
    {label:'RecipientEmail linked',percent:100*hasEmail/n,detail:`${hasEmail} of ${rows.length}`},
    {label:'Valid GPS',percent:100*points.length/n,detail:`${points.length} of ${rows.length}`},
    {label:'Vehicle photo uploaded',percent:100*hasPhoto/n,detail:`${hasPhoto} of ${rows.length}`},
    {label:'External reference linked',percent:100*hasRef/n,detail:`${hasRef} of ${rows.length}`},
    {label:'Response duration captured',percent:100*hasDuration/n,detail:`${hasDuration} of ${rows.length}`},
    {label:'Dwell time ≤ 30 min',percent:100*usableDwell/n,detail:`${usableDwell} of ${rows.length}`}
  ];
}

function stringQuery(v) {
  if (Array.isArray(v)) v = v[0];
  return String(v || '').trim();
}

function filterOptions(rows, surveyMeta) {
  const set = (values) => [...new Set(values.filter(x=>!missing(x)).map(x=>String(x).trim()))].sort((a,b)=>a.localeCompare(b));
  const dates = rows.map(r=>String(r.RecordedDate||r.EndDate||'').slice(0,10)).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  return {
    observers:set(rows.map(r=>String(r.RecipientEmail||'').trim() || 'No RecipientEmail')),
    references:set(rows.map(r=>r.ExternalReference)),
    operations:set(rows.map(r=>resolveChoice(r[operationQuestionId()],surveyMeta[operationQuestionId()]))),
    vehicles:set(rows.map(r=>resolveChoice(r[vehicleQuestionId()],surveyMeta[vehicleQuestionId()]))),
    minDate:dates[0]||'',
    maxDate:dates.at(-1)||''
  };
}

function applyFilters(rows, filters, surveyMeta) {
  const observerNeedle = filters.observer.toLowerCase();
  const referenceNeedle = filters.reference.toLowerCase();
  return rows.filter(r=>{
    const observer = String(r.RecipientEmail||'').trim() || 'No RecipientEmail';
    const reference = String(r.ExternalReference||'').trim();
    const date = String(r.RecordedDate||r.EndDate||'').slice(0,10);
    const operation = resolveChoice(r[operationQuestionId()],surveyMeta[operationQuestionId()]) || '';
    const vehicle = resolveChoice(r[vehicleQuestionId()],surveyMeta[vehicleQuestionId()]) || '';
    if (observerNeedle && !observer.toLowerCase().includes(observerNeedle)) return false;
    if (referenceNeedle && !reference.toLowerCase().includes(referenceNeedle)) return false;
    if (filters.from && date && date < filters.from) return false;
    if (filters.to && date && date > filters.to) return false;
    if (filters.operation && operation !== filters.operation) return false;
    if (filters.vehicle && vehicle !== filters.vehicle) return false;
    return true;
  });
}

function summarize(rows, surveyMeta, context={}) {
  const allRows = context.allRows || rows;
  const emailCounts = new Map();
  for (const r of rows) {
    const email = String(r.RecipientEmail || '').trim() || 'No RecipientEmail';
    emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
  }
  const observerCounts = [...emailCounts.entries()]
    .map(([observer,count])=>({observer,count,identified:observer!=='No RecipientEmail'}))
    .sort((a,b)=>b.count-a.count || a.observer.localeCompare(b.observer));

  const identifiedObservers = new Set(rows.map(r=>String(r.RecipientEmail||'').trim()).filter(Boolean));
  const identifiedResponses = rows.filter(r=>!missing(r.RecipientEmail)).length;

  const dwellAll = rows.map(r=>{
    const a=Date.parse(r.StartDate), b=Date.parse(r.EndDate);
    return Number.isFinite(a)&&Number.isFinite(b) ? (b-a)/60000 : null;
  });
  const dwell = dwellAll.filter(v=>Number.isFinite(v)&&v>=0&&v<=30);
  const duration = rows.map(r=>num(r['Duration (in seconds)'])).filter(Number.isFinite);

  const observations = [];
  const points = [];
  for (const r of rows) {
    const lat = num(get(r,'__js_GPS_Latitude','GPS_Latitude'));
    const lon = num(get(r,'__js_GPS_Longitude','GPS_Longitude'));
    const validGps = lat!=null && lon!=null && Math.abs(lat)<=90 && Math.abs(lon)<=180;
    const email = String(r.RecipientEmail||'').trim() || 'No RecipientEmail';
    const a=Date.parse(r.StartDate), b=Date.parse(r.EndDate);
    const dwellValue = Number.isFinite(a)&&Number.isFinite(b) ? Math.round((b-a)/6000)/10 : null;
    const item = {
      lat:validGps?lat:null,
      lon:validGps?lon:null,
      observer:email,
      externalReference:String(r.ExternalReference||'').trim(),
      id:String(r.ResponseId||'').slice(0,24),
      recorded:String(r.RecordedDate||r.EndDate||'').slice(0,19).replace('T',' '),
      dwell:dwellValue,
      duration:num(r['Duration (in seconds)']),
      progress:num(r.Progress),
      operation:resolveChoice(r[operationQuestionId()],surveyMeta[operationQuestionId()]) || '',
      vehicle:resolveChoice(r[vehicleQuestionId()],surveyMeta[vehicleQuestionId()]) || '',
      hasPhoto:!missing(photoValue(r,'id'))
    };
    observations.push(item);
    if (validGps) points.push(item);
  }

  const cols = [...new Set(rows.flatMap(Object.keys))];
  const rootQuestionCols = cols.map(baseQuestionId).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).filter(c=>!ADMIN.has(c));
  const questions = [];
  for (const c of rootQuestionCols) {
    const vals = rows.map(r=>r[c]).filter(v=>!missing(v));
    if (!vals.length) continue;
    const meta = surveyMeta[c] || {label:c,choices:{},multi:false};
    const hasChoices = Object.keys(meta.choices || {}).length > 0;
    const numeric = vals.map(num);
    const numericRate = numeric.filter(Number.isFinite).length / vals.length;
    if (!hasChoices && numericRate >= .8) {
      const nums=numeric.filter(Number.isFinite);
      questions.push({
        id:c,label:meta.label || c,type:'numeric',
        items:[
          ['Median',Math.round((median(nums)||0)*10)/10],
          ['Mean',Math.round(nums.reduce((a,b)=>a+b,0)/nums.length*10)/10],
          ['n',nums.length]
        ]
      });
    } else {
      questions.push({id:c,label:meta.label||c,type:'categorical',items:categoricalItems(vals,meta)});
    }
  }
  questions.sort((a,b)=>Number(a.id.replace(/\D/g,''))-Number(b.id.replace(/\D/g,'')));

  const imageCount = rows.filter(r=>!missing(photoValue(r,'id'))).length;
  const totalImageCount = allRows.filter(r=>!missing(photoValue(r,'id'))).length;

  return {
    mode:'live',
    generatedAt:new Date().toISOString(),
    filters:context.filters || {},
    filterOptions:context.filterOptions || {},
    summary:{
      responses:rows.length,
      totalResponses:allRows.length,
      gps:points.length,
      observers:identifiedObservers.size,
      identifiedResponses,
      images:imageCount,
      totalImages:totalImageCount,
      medianDwellMin:median(dwell)
    },
    observerCounts,
    durationBins:bins(duration,[60,120,180,240,360,Infinity],['0–60','61–120','121–180','181–240','241–360','361+']),
    dwellBins:bins(dwell,[2,5,10,15,20,30],['0–2','2–5','5–10','10–15','15–20','20–30']),
    quality:operationalQuality(rows,points,dwellAll),
    questions,
    points:points.slice(-4000),
    observations:observations.slice(-4000)
  };
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if (!requireAccess(req,res)) return;

  const token=process.env.QUALTRICS_API_TOKEN;
  const dataCenter=process.env.QUALTRICS_DATA_CENTER||'iad1';
  const surveyId=observationSurveyId();
  if (!token||!surveyId) return res.status(503).json({error:'Qualtrics environment variables are not configured'});

  try {
    const [raw,surveyMeta] = await Promise.all([
      exportResponses({dataCenter,surveyId,token}),
      fetchSurveyMetadata({dataCenter,surveyId,token})
    ]);
    const allRows = raw.filter(isFinished);
    const options = filterOptions(allRows,surveyMeta);
    const filters = {
      observer:stringQuery(req.query?.observer),
      reference:stringQuery(req.query?.reference),
      from:stringQuery(req.query?.from),
      to:stringQuery(req.query?.to),
      operation:stringQuery(req.query?.operation),
      vehicle:stringQuery(req.query?.vehicle)
    };
    const rows = applyFilters(allRows,filters,surveyMeta);
    return res.status(200).json(summarize(rows,surveyMeta,{allRows,filterOptions:options,filters}));
  } catch(e) {
    console.error(e);
    return res.status(502).json({error:'Unable to load Qualtrics data',detail:String(e.message||e)});
  }
}

