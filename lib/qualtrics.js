import { completedResponsesCsv } from './csv.js';

export const missing = x => x == null || (typeof x === 'string' && x.trim() === '');

export function num(x) {
  if (missing(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function simpleValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(simpleValue).filter(x => !missing(x)).join('; ');
  if (typeof v === 'object') {
    if ('label' in v) return simpleValue(v.label);
    if ('value' in v && Object.keys(v).length <= 2) return simpleValue(v.value);
    const vals = Object.values(v).map(simpleValue).filter(x => !missing(x));
    return vals.length ? vals.join('; ') : null;
  }
  return v;
}

export async function qfetch(url, token, options = {}) {
  const headers = {
    'X-API-TOKEN': token,
    'Accept': 'application/json',
    ...(options.body ? {'Content-Type':'application/json'} : {}),
    ...(options.headers || {})
  };
  const r = await fetch(url, { ...options, headers });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 600); } catch {}
    throw new Error(`Qualtrics ${r.status}: ${detail}`);
  }
  return r;
}

export function normalizeResponse(r) {
  const values = r && typeof r.values === 'object' && !Array.isArray(r.values) ? r.values : {};
  const labels = r && typeof r.labels === 'object' && !Array.isArray(r.labels) ? r.labels : {};
  const displayedValues = r && typeof r.displayedValues === 'object' && !Array.isArray(r.displayedValues) ? r.displayedValues : {};
  const row = { ...values };

  for (const [k, v] of Object.entries(labels)) {
    const s = simpleValue(v);
    if (!missing(s)) row[k] = s;
  }
  for (const [k, v] of Object.entries(displayedValues)) {
    const s = simpleValue(v);
    if (missing(row[k]) && !missing(s)) row[k] = s;
  }

  const aliases = {
    'ResponseId': [r?.responseId, values._recordId, values.responseId, values.ResponseId],
    'StartDate': [values.startDate, values.StartDate],
    'EndDate': [values.endDate, values.EndDate],
    'Status': [values.status, values.Status],
    'IPAddress': [values.ipAddress, values.IPAddress],
    'Progress': [values.progress, values.Progress],
    'Duration (in seconds)': [values.duration, values['Duration (in seconds)']],
    'Finished': [values.finished, values.Finished],
    'RecordedDate': [values.recordedDate, values.RecordedDate],
    'RecipientLastName': [values.recipientLastName, values.RecipientLastName],
    'RecipientFirstName': [values.recipientFirstName, values.RecipientFirstName],
    'RecipientEmail': [values.recipientEmail, values.RecipientEmail],
    'ExternalReference': [values.externalDataReference, values.externalReference, values.ExternalReference],
    'LocationLatitude': [values.locationLatitude, values.LocationLatitude],
    'LocationLongitude': [values.locationLongitude, values.LocationLongitude],
    'DistributionChannel': [values.distributionChannel, values.DistributionChannel],
    'UserLanguage': [values.userLanguage, values.UserLanguage],
    'Last Seen Flow Element ID': [values.LastSeenFlowID, values['Last Seen Flow Element ID']],
    'Last Seen Question IDs': [values.LastSeenQuestions, values['Last Seen Question IDs']]
  };
  for (const [target, candidates] of Object.entries(aliases)) {
    const found = candidates.find(v => !missing(v));
    if (!missing(found)) row[target] = found;
  }

  for (const k of [
    '_recordId','responseId','startDate','endDate','status','ipAddress','progress','duration',
    'finished','recordedDate','recipientLastName','recipientFirstName','recipientEmail',
    'externalDataReference','externalReference','locationLatitude','locationLongitude',
    'distributionChannel','userLanguage','LastSeenFlowID','LastSeenQuestions'
  ]) delete row[k];

  return row;
}

async function exportResponseFile({ dataCenter, surveyId, token, format='json', useLabels, breakoutSets }) {
  const base = `https://${dataCenter}.qualtrics.com/API/v3/surveys/${encodeURIComponent(surveyId)}/export-responses`;
  const start = await (await qfetch(base, token, {
    method: 'POST',
    body: JSON.stringify({ format, compress:false, ...(useLabels===undefined?{}:{useLabels}), ...(breakoutSets===undefined?{}:{breakoutSets}) })
  })).json();

  const pid = start?.result?.progressId;
  if (!pid) throw new Error('No Qualtrics progressId');

  let fid = null;
  for (let i = 0; i < 70; i++) {
    await new Promise(r => setTimeout(r, 700));
    const p = await (await qfetch(`${base}/${pid}`, token)).json();
    const status = String(p?.result?.status || '').toLowerCase();
    if (status === 'complete') { fid = p.result.fileId; break; }
    if (status === 'failed') throw new Error('Qualtrics export failed');
  }
  if (!fid) throw new Error('Qualtrics export timed out');

  const f = await qfetch(`${base}/${fid}/file`, token, format==='csv'?{headers:{Accept:'*/*'}}:{});
  return f.text();
}

export async function exportResponsesCsv(options) {
  return completedResponsesCsv(await exportResponseFile({...options,format:'csv',useLabels:true,breakoutSets:false}));
}

export async function exportResponses(options) {
  const text = await exportResponseFile(options);
  const obj = JSON.parse(text.replace(/^\uFEFF/,''));

  let arr = [];
  if (Array.isArray(obj)) arr = obj;
  else if (Array.isArray(obj.responses)) arr = obj.responses;
  else if (Array.isArray(obj?.result?.responses)) arr = obj.result.responses;
  else arr = Object.values(obj).find(Array.isArray) || [];

  return arr.map(normalizeResponse);
}

function stripHtml(text='') {
  return String(text)
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const FALLBACK_LABELS = {
  QID9: '¿El vehículo tiene placas visibles?',
  QID27: 'Tipo de operación',
  QID28: '¿Dónde se recoge la mercancía?',
  QID8: 'Tipo de vehículo',
  QID29: '¿El vehículo permanece encendido durante la operación?',
  QID11: '¿Dónde se transporta la mercancía?',
  QID10: '¿El vehículo pertenece a alguna marca visible?',
  QID12: '¿Dónde se estacionó?',
  QID25: '¿Cuántas personas van en el vehículo?',
  QID22: 'Sexo aparente de quien entrega la mercancía',
  QID23: 'Edad aparente de quien entrega la mercancía',
  QID4: '¿Utiliza uniforme o ropa con marca?',
  QID7: 'Equipo de protección',
  QID2: '¿Dónde se realiza la entrega?',
  QID3: '¿Qué tipo de mercancía se va a entregar?',
  QID13: 'Número de paquetes',
  QID15: 'Distancia estimada del vehículo al punto de entrega',
  QID14: 'Número de recorridos vehículo–cliente',
  QID30: '¿Qué situaciones se presentaron durante la operación?',
  QID16: '¿Dónde entrega la mercancía?'
};

const FALLBACK_MULTI = new Set(['QID7','QID30']);

export async function fetchSurveyMetadata({ dataCenter, surveyId, token }) {
  const result = {};
  try {
    const url = `https://${dataCenter}.qualtrics.com/API/v3/surveys/${encodeURIComponent(surveyId)}`;
    const body = await (await qfetch(url, token)).json();
    const questions = body?.result?.Questions || body?.result?.questions || {};
    for (const [qid, q] of Object.entries(questions)) {
      const choices = {};
      const sourceChoices = q?.Choices || q?.choices || {};
      for (const [choiceId, choice] of Object.entries(sourceChoices)) {
        choices[String(choiceId)] = stripHtml(
          choice?.Display ?? choice?.display ?? choice?.Description ?? choice?.description ?? choiceId
        );
      }
      const selector = String(q?.Selector ?? q?.selector ?? '');
      result[qid] = {
        label: stripHtml(q?.QuestionText ?? q?.questionText ?? FALLBACK_LABELS[qid] ?? qid),
        choices,
        multi: /^MA/i.test(selector) || FALLBACK_MULTI.has(qid)
      };
    }
  } catch (e) {
    console.warn('Unable to load Qualtrics survey metadata; using fallback labels.', e?.message || e);
  }

  for (const [qid, label] of Object.entries(FALLBACK_LABELS)) {
    if (!result[qid]) result[qid] = { label, choices:{}, multi:FALLBACK_MULTI.has(qid) };
    else if (!result[qid].label || result[qid].label === qid) result[qid].label = label;
  }
  return result;
}

export function isFinished(row) {
  const f = String(row?.Finished ?? '').toLowerCase();
  return ['true','1','yes'].includes(f);
}

export function safeFilename(value, fallback='file') {
  const s = String(value || fallback).split(/[\\/]/).pop() || fallback;
  return s.replace(/[^A-Za-z0-9@._+-]+/g, '_').replace(/^\.+|\.+$/g,'').slice(0,180) || fallback;
}

// Numeric typing comes from this survey's own definition, never a country tag list.
export async function fetchExportFieldTypes({dataCenter,surveyId,token}) {
  try{
    const url='https://'+dataCenter+'.qualtrics.com/API/v3/surveys/'+encodeURIComponent(surveyId);
    const body=await(await qfetch(url,token,{signal:AbortSignal.timeout(10000)})).json();
    const questions=body?.result?.Questions??body?.result?.questions;
    if(!questions||typeof questions!=='object'||Array.isArray(questions)||!Object.keys(questions).length)throw new Error('No question metadata');
    const numericQuestionIds=[],fileUploadQuestionIds=[];
    for(const [key,question] of Object.entries(questions)){
      const raw=question?.QuestionType??question?.questionType;
      const type=String(typeof raw==='object'?raw?.type:raw??'');
      const selector=String(question?.Selector??question?.selector??(typeof raw==='object'?raw?.selector:'')??'');
      const validation=question?.Validation?.Settings??question?.validation??{};
      const contentType=String(validation.ContentType??validation.contentType??validation.type??'');
      const qid=String(question?.QuestionID??question?.questionId??key);
      if((/^TE$/i.test(type)||(/^Matrix$/i.test(type)&&/^TE$/i.test(selector)))&&/^ValidNumber$/i.test(contentType)){
        numericQuestionIds.push(qid);
      }
      if(/^FileUpload$/i.test(type))fileUploadQuestionIds.push(qid);
    }
    return {numericQuestionIds,fileUploadQuestionIds,available:true};
  }catch{
    console.warn('Numeric question metadata is unavailable; response text will be preserved.');
    return {numericQuestionIds:[],fileUploadQuestionIds:[],available:false};
  }
}

