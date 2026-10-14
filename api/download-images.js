import { observationSurveyId, photoValue } from '../lib/config.js';
import archiver from 'archiver';
import { exportResponses, isFinished, missing, safeFilename } from '../lib/qualtrics.js';
import { requireAccess } from '../lib/auth.js';

function get(r,...keys){
  for(const k of keys) if(!missing(r[k])) return r[k];
  return null;
}

function csvEscape(v='') {
  const s=String(v??'');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

function manifestCsv(rows) {
  const headers=['ResponseId','RecipientEmail','ExternalReference','file_id','original_name','saved_path','status','error'];
  return [headers.join(','),...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\n');
}

export default async function handler(req,res) {
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if(!requireAccess(req,res)) return;

  const token=process.env.QUALTRICS_API_TOKEN;
  const dataCenter=process.env.QUALTRICS_DATA_CENTER||'iad1';
  const surveyId=observationSurveyId();
  if(!token||!surveyId) return res.status(503).json({error:'Qualtrics environment variables are not configured'});

  try {
    const rows=(await exportResponses({dataCenter,surveyId,token})).filter(isFinished);
    const photos=rows.map(r=>({
      responseId:String(r.ResponseId||''),
      observer:String(r.RecipientEmail||'').trim()||'No_RecipientEmail',
      externalReference:String(r.ExternalReference||'').trim(),
      fileId:String(photoValue(r,'id')||''),
      fileName:String(photoValue(r,'name')||'image')
    })).filter(x=>x.responseId&&x.fileId);

    if(!photos.length) return res.status(404).json({error:'No uploaded vehicle images were found in completed responses.'});

    const date=new Date().toISOString().slice(0,10);
    const zipName=`ILI_Honduras_vehicle_photos_${date}.zip`;
    res.statusCode=200;
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="${zipName}"`);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(typeof res.flushHeaders==='function') res.flushHeaders();

    const archive=archiver('zip',{zlib:{level:6}});
    archive.on('warning',err=>console.warn('ZIP warning',err));
    archive.on('error',err=>{
      console.error('ZIP error',err);
      if(!res.headersSent) res.status(500).end('Unable to create ZIP');
      else res.destroy(err);
    });
    archive.pipe(res);

    const manifest=[];
    for(const p of photos){
      const original=safeFilename(p.fileName,`${p.fileId}.bin`);
      const folder=safeFilename(p.observer,'No_RecipientEmail');
      const savedPath=`${folder}/${safeFilename(p.responseId,'response')}__${original}`;
      const record={
        ResponseId:p.responseId,
        RecipientEmail:p.observer==='No_RecipientEmail'?'':p.observer,
        ExternalReference:p.externalReference,
        file_id:p.fileId,
        original_name:original,
        saved_path:savedPath,
        status:'failed',
        error:''
      };
      try{
        const url=`https://${dataCenter}.qualtrics.com/API/v3/surveys/${encodeURIComponent(surveyId)}/responses/${encodeURIComponent(p.responseId)}/uploaded-files/${encodeURIComponent(p.fileId)}`;
        const r=await fetch(url,{headers:{'X-API-TOKEN':token,'Accept':'*/*'}});
        if(!r.ok) throw new Error(`Qualtrics ${r.status}: ${(await r.text()).slice(0,250)}`);
        const contentType=String(r.headers.get('content-type')||'').toLowerCase();
        if(contentType.includes('text/html')) throw new Error('Received HTML instead of the uploaded file.');
        const buf=Buffer.from(await r.arrayBuffer());
        archive.append(buf,{name:savedPath});
        record.status='downloaded';
      }catch(e){
        record.error=String(e?.message||e);
      }
      manifest.push(record);
    }

    archive.append(manifestCsv(manifest),{name:'photo_manifest.csv'});
    const failures=manifest.filter(x=>x.status!=='downloaded');
    if(failures.length){
      archive.append(failures.map(x=>`${x.ResponseId}: ${x.error}`).join('\n'),{name:'download_errors.txt'});
    }
    await archive.finalize();
  }catch(e){
    console.error(e);
    if(!res.headersSent) return res.status(502).json({error:'Unable to prepare image ZIP',detail:String(e?.message||e)});
    try{res.end();}catch{}
  }
}

