import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { parseCsvRecords, completedResponsesCsv } from '../lib/csv.js';
import { exportResponses, exportResponsesCsv, fetchExportFieldTypes } from '../lib/qualtrics.js';
import { surveyWorkbookBuffer, tableWorkbookBuffer, XLSX_CONTENT_TYPE } from '../lib/excel.js';
import observationsDownload from '../api/download-raw-data.js';
import couriersDownload from '../api/download-courier-data.js';
import observersDownload from '../api/download-observers.js';

// These schemas and every response below are SYNTHETIC test cases, not survey data.
// Variable names are intentionally unrelated to any country's questionnaire.
const SYNTHETIC_SCHEMA = {
  headers: ['ResponseId','Finished','SyntheticChoice','Repeated','Survey order / B','Repeated','SyntheticAmount','SyntheticUpload_Size','SyntheticOther','SyntheticMatrix_1','SyntheticAmountLookalike','SyntheticBlankTail'],
  labels: ['Response ID','Finished','A categorical choice','First repeated field\r\nfull question text','Unrelated text field\rsecond line','Second repeated field','Numeric amount','Uploaded file size','Categoría: ¿sí o no? 🚚','Numeric matrix entry','Another numeric-looking text field','Always blank trailing column'],
  imports: ['_recordId','finished','QID555','QID556','embedded-field','QID557','QID101_TEXT','QID102_FILE_SIZE','externalReference','QID103_1','QID1010_TEXT','trailing-blank']
};
const HONDURAS_SURVEY_IDS = { observations: 'SV_9LXy32LyJuSlvgi', couriers: 'SV_8e48NZfmjF2fFrM' };
const FIELD_TYPES = { numericQuestionIds: ['QID101','QID103'], fileUploadQuestionIds: ['QID102'], available: true };
const LOWER_METADATA = { result: { questions: {
  QID101: { questionType: { type: 'TE' }, validation: { type: 'ValidNumber' } },
  QID103: { questionType: { type: 'Matrix', selector: 'TE' }, validation: { type: 'ValidNumber' } },
  QID102: { questionType: { type: 'FileUpload' } },
  QID199: { questionType: { type: 'MC' }, validation: { type: 'ValidNumber' } },
  QID198: { questionType: { type: 'TE' }, validation: { type: 'Custom' } },
  QID197: { questionType: { type: 'Matrix', selector: 'Likert' }, validation: { type: 'ValidNumber' } },
  QID196: { questionType: { type: 'TE' } },
  QID194: { questionType: { type: 'TE' }, validation: { type: 'Number' } },
  QID193: { questionType: { type: 'TE' }, validation: { type: 'Numeric' } }
} } };
const UPPER_METADATA = { result: { Questions: {
  QID201: { QuestionType: 'TE', Validation: { Settings: { ContentType: 'ValidNumber' } } },
  QID203: { QuestionType: 'Matrix', Selector: 'TE', Validation: { Settings: { ContentType: 'ValidNumber' } } },
  QID202: { QuestionType: 'FileUpload' },
  QID299: { QuestionType: 'MC', Validation: { Settings: { ContentType: 'ValidNumber' } } },
  QID298: { QuestionType: 'TE', Validation: { Settings: { ContentType: 'ValidEmail' } } },
  QID297: { QuestionType: 'Matrix', Selector: 'Likert', Validation: { Settings: { ContentType: 'ValidNumber' } } },
  QID294: { QuestionType: 'TE', Validation: { Settings: { ContentType: 'Number' } } },
  QID293: { QuestionType: 'TE', Validation: { Settings: { ContentType: 'Numeric' } } }
} } };
const csvCell = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
const csvRecord = values => values.map(csvCell).join(',');

function nativeExport({ schema = SYNTHETIC_SCHEMA, importIds = true, statuses = ['True'] } = {}) {
  const metadata = [schema.headers, schema.labels];
  if (importIds) metadata.push(schema.imports.map(ImportId => JSON.stringify({ ImportId })));
  const rows = statuses.map((finished, index) => {
    const values = Array(schema.headers.length).fill('');
    values[schema.headers.indexOf('Finished')] = finished;
    values[schema.headers.indexOf('ResponseId')] = 'R_SYNTHETIC_' + index;
    return values;
  });
  return { schema, metadata, rows };
}
function encodeNative(sample) {
  return '\uFEFF' + [...sample.metadata, ...sample.rows].map(csvRecord).join('\r\n') + '\r\n';
}
function fillSynthetic(sample) {
  const values = ['R_SYNTHETIC_0','True','4','línea uno,\r\nlínea dos; "sí" 🚚','=1+1','000123','12.50','23000','categoría 5','3.25','000456',''];
  for (const row of sample.rows) {
    sample.schema.headers.forEach((header, index) => {
      if (header !== 'Finished' && header !== 'ResponseId') row[index] = values[index] ?? '';
    });
  }
  return sample;
}
async function workbook(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'Downloads must be binary Buffers');
  assert.equal(buffer.subarray(0,2).toString('ascii'), 'PK');
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(buffer);
  return result;
}
const expectedExcelText = value => typeof value === 'string' ? value.replace(/\r\n?/g,'\n') : value;
const expectedExcelValues = values => values.map(expectedExcelText);
function cells(sheet, row, count) {
  return Array.from({ length: count }, (_, index) => sheet.getCell(row,index+1).value ?? '');
}
function configureEnv(t, overrides = {}) {
  const desired = {
    QUALTRICS_API_TOKEN: 'SYNTHETIC_TOKEN',
    QUALTRICS_DATA_CENTER: 'iad1',
    QUALTRICS_SURVEY_ID: HONDURAS_SURVEY_IDS.observations,
    QUALTRICS_COURIER_SURVEY_ID: HONDURAS_SURVEY_IDS.couriers,
    DASHBOARD_ACCESS_CODE: '',
    ...overrides
  };
  const previous = Object.fromEntries(Object.keys(desired).map(key => [key,process.env[key]]));
  for (const [key,value] of Object.entries(desired)) value == null ? delete process.env[key] : process.env[key] = value;
  t.after(() => {
    for (const [key,value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
  });
}
function mockQualtrics(t, {
  csv = encodeNative(nativeExport()),
  metadata = LOWER_METADATA,
  metadataStatus = 200,
  json = JSON.stringify({ responses: [] })
} = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url,options = {}) => {
    const address = String(url);
    calls.push({ url: address, options });
    if (options.method === 'POST' && address.endsWith('/export-responses')) {
      return new Response(JSON.stringify({ result: { progressId: 'SYNTHETIC_PROGRESS' } }));
    }
    if (address.endsWith('/export-responses/SYNTHETIC_PROGRESS')) {
      return new Response(JSON.stringify({ result: { status: 'complete', fileId: 'SYNTHETIC_FILE' } }));
    }
    if (address.endsWith('/export-responses/SYNTHETIC_FILE/file')) {
      const started = calls.find(call => call.options.method === 'POST');
      const format = JSON.parse(started.options.body).format;
      return new Response(format === 'json' ? json : csv);
    }
    if (/\/API\/v3\/surveys\/[^/]+$/.test(address)) {
      return new Response(JSON.stringify(metadata), { status: metadataStatus });
    }
    throw new Error('Unexpected Qualtrics request: ' + address);
  });
  return calls;
}
function response() {
  return {
    statusCode: 200, headersSent: false, headers: {}, buffer: Buffer.alloc(0), ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; this.ended = true; return this; },
    setHeader(name,value) { this.headers[name.toLowerCase()] = value; },
    write(value) { this.headersSent = true; this.buffer = Buffer.concat([this.buffer,Buffer.isBuffer(value) ? value : Buffer.from(value)]); },
    end(value) { if (value != null) this.write(value); this.ended = true; },
    flushHeaders() { this.headersSent = true; }
  };
}

test('native CSV preserves dynamic order, duplicate tags, full labels, and two or three metadata rows', async t => {
  for (const importIds of [false,true]) {
    await t.test(importIds ? 'with ImportId row' : 'without ImportId row', () => {
      const sample = fillSynthetic(nativeExport({ importIds, statuses: ['True','0','yes','','no'] }));
      const rows = parseCsvRecords(completedResponsesCsv(encodeNative(sample))).map(record => record.values);
      assert.deepEqual(rows.slice(0,sample.metadata.length),sample.metadata);
      assert.deepEqual(rows.slice(sample.metadata.length),[sample.rows[0],sample.rows[2]]);
      assert.equal(rows[0].filter(value => value === 'Repeated').length,2);
      assert.equal(rows.at(-1).length,SYNTHETIC_SCHEMA.headers.length);
      assert.equal(rows.at(-1).at(-1),'');
    });
  }
});

test('CSV validation handles quoted commas, accents, CRLF, formulas as text, and malformed input', () => {
  const parsed = parseCsvRecords('\uFEFFa,b,c\r\n"1,2","say ""sí""","line 1\r\nline 2 🚚"\r\n=1+1,000123,');
  assert.deepEqual(parsed.map(row => row.values),[['a','b','c'],['1,2','say "sí"','line 1\r\nline 2 🚚'],['=1+1','000123','']]);
  for (const bad of ['a,b\n"unterminated','a,b\nnot"quoted,b','a,b\n"closed"tail,b']) {
    assert.throws(() => parseCsvRecords(bad));
  }
  assert.throws(() => completedResponsesCsv('OnlyHeader\nOnly label\nvalue\n'));
  assert.throws(() => completedResponsesCsv(encodeNative(nativeExport({ statuses: ['unexpected'] }))));
});

test('workbook keeps native rows, duplicate positions, exact text, and a separate positional dictionary', async t => {
  for (const importIds of [false,true]) {
    await t.test(importIds ? 'three metadata records' : 'two metadata records', async () => {
      const sample = fillSynthetic(nativeExport({ importIds, statuses: ['True','False','1'] }));
      const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample)));
      assert.deepEqual(result.worksheets.map(sheet => sheet.name),['Sheet0','Data dictionary']);
      const sheet = result.getWorksheet('Sheet0'), guide = result.getWorksheet('Data dictionary');
      assert.equal(sheet.columnCount,SYNTHETIC_SCHEMA.headers.length);
      assert.equal(sheet.rowCount,4);
      assert.deepEqual(cells(sheet,1,sheet.columnCount),SYNTHETIC_SCHEMA.headers);
      assert.deepEqual(cells(sheet,2,sheet.columnCount),expectedExcelValues(SYNTHETIC_SCHEMA.labels));
      assert.deepEqual(cells(sheet,3,sheet.columnCount),expectedExcelValues(sample.rows[0]));
      assert.deepEqual(cells(sheet,4,sheet.columnCount),expectedExcelValues(sample.rows[2]));
      assert.equal(sheet.getCell(2,4).value,'First repeated field\nfull question text');
      assert.equal(sheet.getCell(2,5).value,'Unrelated text field\nsecond line');
      assert.equal(sheet.getCell(3,5).value,'=1+1');
      assert.equal(sheet.getCell(3,5).type,ExcelJS.ValueType.String);
      assert.equal(sheet.views[0].state,'frozen');
      assert.equal(sheet.views[0].ySplit,2);
      assert.ok(!sheet.autoFilter,'Native two-header sheet should not treat question labels as a response');
      assert.deepEqual(cells(guide,1,6),['Column','Excel column','Variable','Question / field','ImportId','Excel type']);
      assert.equal(guide.rowCount,SYNTHETIC_SCHEMA.headers.length+1);
      SYNTHETIC_SCHEMA.headers.forEach((header,index) => {
        assert.equal(guide.getCell(index+2,1).value,index+1);
        assert.equal(guide.getCell(index+2,2).value,String.fromCharCode(65+index));
        assert.equal(guide.getCell(index+2,3).value,header);
        assert.equal(guide.getCell(index+2,4).value,expectedExcelText(SYNTHETIC_SCHEMA.labels[index]));
        assert.equal(guide.getCell(index+2,5).value ?? '',importIds ? SYNTHETIC_SCHEMA.imports[index] : '');
      });
    });
  }
});

test('metadata enables only numeric text-entry and upload-size fields, with boundary-safe ImportIds', async () => {
  const schema = {
    headers: ['ResponseId','Finished','Exact numeric','Underscore numeric','Hash numeric','Near match','Upload size','Upload name','Categorical code','ID','Unvalidated numeric-looking'],
    labels: ['Response','Finished','Amount','Amount part','Matrix entry','Other field','File size','File name','Preference','ID','Unvalidated'],
    imports: ['_recordId','finished','QID101','QID101_TEXT','QID103#2','QID1010_TEXT','QID102_FILE_SIZE','QID102_FILE_NAME','QID555','externalReference','QID777_TEXT']
  };
  const sample = nativeExport({ schema });
  sample.rows[0] = ['R_SYNTHETIC_0','True','12.5','-2.25','3.75','000456','23000','000123','4','000789','123.5'];
  const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample),{ fieldTypes: FIELD_TYPES }));
  const sheet = result.getWorksheet('Sheet0'), guide = result.getWorksheet('Data dictionary');
  assert.deepEqual(cells(sheet,3,schema.headers.length),['R_SYNTHETIC_0','True',12.5,-2.25,3.75,'000456',23000,'000123','4','000789','123.5']);
  for (const column of [3,4,5,7]) {
    assert.equal(sheet.getCell(3,column).type,ExcelJS.ValueType.Number);
    assert.equal(guide.getCell(column+1,6).value,'Number');
  }
  for (const column of [6,8,9,10,11]) assert.equal(sheet.getCell(3,column).type,ExcelJS.ValueType.String);
});

test('missing metadata or ImportIds never guesses numeric types from values or variable names', async () => {
  for (const importIds of [false,true]) {
    for (const fieldTypes of [{}, { numericQuestionIds: [], fileUploadQuestionIds: [], available: false }]) {
      const sample = fillSynthetic(nativeExport({ importIds }));
      const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample),{ fieldTypes }));
      assert.deepEqual(cells(result.getWorksheet('Sheet0'),3,SYNTHETIC_SCHEMA.headers.length),expectedExcelValues(sample.rows[0]));
    }
  }
  const sample = fillSynthetic(nativeExport({ importIds: false }));
  const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample),{ fieldTypes: FIELD_TYPES }));
  assert.deepEqual(cells(result.getWorksheet('Sheet0'),3,SYNTHETIC_SCHEMA.headers.length),expectedExcelValues(sample.rows[0]));
});

test('another synthetic survey can add, reorder, and duplicate columns without a fixed schema', async () => {
  const schema = {
    headers: ['Later field','Finished','ResponseId',...Array.from({length:25},(_,i) => 'Synthetic_' + (25-i)),'Later field','Trailing empty'],
    labels: ['First duplicate','Finished','Response ID',...Array.from({length:25},(_,i) => 'Question ' + (25-i)),'Second duplicate','Always blank'],
    imports: ['later_1','finished','_recordId',...Array.from({length:25},(_,i) => 'QID' + (900+i)),'later_2','empty']
  };
  const sample = nativeExport({ schema });
  sample.rows[0][0] = 'first duplicate value';
  sample.rows[0][28] = 'second duplicate value';
  const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample)));
  const sheet = result.getWorksheet('Sheet0'), guide = result.getWorksheet('Data dictionary');
  assert.equal(sheet.columnCount,30);
  assert.deepEqual(cells(sheet,1,30),schema.headers);
  assert.deepEqual(cells(sheet,2,30),expectedExcelValues(schema.labels));
  assert.deepEqual(cells(sheet,3,30),expectedExcelValues(sample.rows[0]));
  assert.equal(guide.getCell(28,2).value,'AA');
  assert.equal(guide.getCell(31,2).value,'AD');
});

test('header-only exports keep every field and label while incomplete rows remain excluded', async () => {
  for (const importIds of [false,true]) {
    for (const statuses of [[],['False','0','']]) {
      const sample = nativeExport({ importIds,statuses });
      const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample)));
      const sheet = result.getWorksheet('Sheet0');
      assert.equal(sheet.rowCount,2);
      assert.equal(sheet.columnCount,SYNTHETIC_SCHEMA.headers.length);
      assert.deepEqual(cells(sheet,1,sheet.columnCount),SYNTHETIC_SCHEMA.headers);
      assert.deepEqual(cells(sheet,2,sheet.columnCount),expectedExcelValues(SYNTHETIC_SCHEMA.labels));
      assert.equal(result.getWorksheet('Data dictionary').rowCount,SYNTHETIC_SCHEMA.headers.length+1);
    }
  }
});

test('malformed CSV fails before a workbook is produced and excessive cell text is rejected', async () => {
  await assert.rejects(surveyWorkbookBuffer('Finished,ResponseId\nFinished,Response\nTrue,"unterminated'));
  const sample = nativeExport();
  sample.rows[0][2] = 'x'.repeat(32768);
  await assert.rejects(surveyWorkbookBuffer(encodeNative(sample)),/Excel cell text limit/);
});

test('lowercase survey metadata selects only explicitly validated numeric entry questions', async t => {
  const calls = mockQualtrics(t);
  const types = await fetchExportFieldTypes({ dataCenter: 'ca1',surveyId: 'SV_SYNTHETIC',token: 'SYNTHETIC_TOKEN' });
  assert.deepEqual([...types.numericQuestionIds].sort(),['QID101','QID103']);
  assert.deepEqual([...types.fileUploadQuestionIds],['QID102']);
  assert.equal(types.available,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://ca1.qualtrics.com/API/v3/surveys/SV_SYNTHETIC');
  assert.equal(calls[0].options.headers['X-API-TOKEN'],'SYNTHETIC_TOKEN');
});

test('uppercase survey metadata supports numeric text entry and matrix validation without choice recoding', async t => {
  mockQualtrics(t,{ metadata: UPPER_METADATA });
  const types = await fetchExportFieldTypes({ dataCenter: 'iad1',surveyId: 'SV_SYNTHETIC',token: 'SYNTHETIC_TOKEN' });
  assert.deepEqual([...types.numericQuestionIds].sort(),['QID201','QID203']);
  assert.deepEqual([...types.fileUploadQuestionIds],['QID202']);
  assert.equal(types.available,true);
});

test('Number and Numeric aliases do not authorize numeric coercion',async t => {
  mockQualtrics(t,{ metadata: LOWER_METADATA });
  const fieldTypes = await fetchExportFieldTypes({ dataCenter: 'iad1',surveyId: 'SV_SYNTHETIC',token: 'SYNTHETIC_TOKEN' });
  const schema = {
    headers: ['ResponseId','Finished','Validated amount','Number alias','Numeric alias'],
    labels: ['Response ID','Finished','Explicit ValidNumber','Unrecognized Number alias','Unrecognized Numeric alias'],
    imports: ['_recordId','finished','QID101_TEXT','QID194_TEXT','QID193_TEXT']
  };
  const sample = nativeExport({ schema });
  sample.rows[0] = ['R_SYNTHETIC_0','True','12.5','000123','3.5'];
  const result = await workbook(await surveyWorkbookBuffer(encodeNative(sample),{ fieldTypes }));
  assert.deepEqual(cells(result.getWorksheet('Sheet0'),3,5),['R_SYNTHETIC_0','True',12.5,'000123','3.5']);
});

test('empty or unavailable metadata has a nonfatal text-preserving fallback', async t => {
  for (const scenario of [{ metadata: {} }, { metadata: { result: {} } }, { metadata: { result: { questions: {} } } }, { metadata: { error: 'unavailable' },metadataStatus: 503 }]) {
    await t.test(JSON.stringify(scenario),async subtest => {
      mockQualtrics(subtest,scenario);
      subtest.mock.method(console,'warn',() => {});
      const types = await fetchExportFieldTypes({ dataCenter: 'iad1',surveyId: 'SV_SYNTHETIC',token: 'SYNTHETIC_TOKEN' });
      assert.deepEqual(types.numericQuestionIds,[]);
      assert.deepEqual(types.fileUploadQuestionIds,[]);
      assert.equal(types.available,false);
    });
  }
});

test('native CSV export uses the correct options, token, escaped survey, and progress/file requests', async t => {
  const native = encodeNative(nativeExport());
  const calls = mockQualtrics(t,{ csv: native });
  const output = await exportResponsesCsv({ dataCenter: 'ca1',surveyId: 'SV_SYNTHETIC /?',token: 'SYNTHETIC_TOKEN' });
  assert.equal(output,native);
  assert.equal(calls.length,3);
  assert.equal(calls[0].url,'https://ca1.qualtrics.com/API/v3/surveys/SV_SYNTHETIC%20%2F%3F/export-responses');
  assert.deepEqual(JSON.parse(calls[0].options.body),{ format: 'csv',compress: false,useLabels: true,breakoutSets: false });
  assert.equal(calls[1].url,calls[0].url+'/SYNTHETIC_PROGRESS');
  assert.equal(calls[2].url,calls[0].url+'/SYNTHETIC_FILE/file');
  for (const call of calls) assert.equal(call.options.headers['X-API-TOKEN'],'SYNTHETIC_TOKEN');
});

test('dashboard JSON analytics keep the original request and normalization', async t => {
  const calls = mockQualtrics(t,{ json: JSON.stringify({ responses: [{
    responseId: 'R_SYNTHETIC',
    values: { startDate: '2026-10-16T12:00:00Z',finished: 1,QID555: 2,QID556: [1,2] },
    labels: { QID555: 'Entrega',QID556: ['Casco','Guantes'] }
  }] }) });
  const rows = await exportResponses({ dataCenter: 'iad1',surveyId: 'SV_SYNTHETIC',token: 'SYNTHETIC_TOKEN' });
  assert.deepEqual(JSON.parse(calls[0].options.body),{ format: 'json',compress: false });
  assert.deepEqual(rows,[{ QID555: 'Entrega',QID556: 'Casco; Guantes',ResponseId: 'R_SYNTHETIC',StartDate: '2026-10-16T12:00:00Z',Finished: 1 }]);
});

for (const [name,handler,prefix] of [
  ['observations',observationsDownload,'ILI_Honduras_observations_'],
  ['couriers',couriersDownload,'ILI_Honduras_courier_survey_']
]) {
  test(name+' instrument downloads remain XLSX even with legacy CSV query strings',async t => {
    for (const format of [undefined,'csv','qualtrics','dictionary']) {
      await t.test(String(format),async subtest => {
        configureEnv(subtest);
        const sample = fillSynthetic(nativeExport({ statuses: ['True','False'] }));
        const calls = mockQualtrics(subtest,{ csv: encodeNative(sample) });
        const res = response();
        await handler({ method: 'GET',headers: {},query: { format } },res);
        assert.equal(res.statusCode,200);
        assert.equal(res.ended,true);
        assert.equal(res.headers['content-type'],XLSX_CONTENT_TYPE);
        assert.match(res.headers['content-disposition'],new RegExp(prefix+'\\d{4}-\\d{2}-\\d{2}\\.xlsx'));
        assert.equal(res.headers['cache-control'],'private, no-store');
        assert.equal(res.headers['x-content-type-options'],'nosniff');
        assert.equal(Number(res.headers['content-length']),res.buffer.length);
        const result = await workbook(res.buffer),sheet = result.getWorksheet('Sheet0');
        assert.deepEqual(result.worksheets.map(value => value.name),['Sheet0','Data dictionary']);
        assert.equal(sheet.rowCount,3);
        assert.deepEqual(cells(sheet,1,sheet.columnCount),sample.schema.headers);
        assert.deepEqual(cells(sheet,2,sheet.columnCount),expectedExcelValues(sample.schema.labels));
        assert.equal(sheet.getCell(3,7).value,12.5);
        assert.equal(sheet.getCell(3,8).value,23000);
        assert.equal(sheet.getCell(3,3).value,'4');
        const expectedBase = 'https://iad1.qualtrics.com/API/v3/surveys/'+HONDURAS_SURVEY_IDS[name];
        assert.ok(calls.some(call => call.url === expectedBase));
        assert.ok(calls.some(call => call.url === expectedBase+'/export-responses' && call.options.method === 'POST'));
        assert.equal(calls.length,4);
        for (const call of calls) assert.equal(call.options.headers['X-API-TOKEN'],'SYNTHETIC_TOKEN');
      });
    }
  });

  test(name+' preserves method and required-token checks before upstream calls',async t => {
    for (const scenario of [
      { env: {},req: { method: 'POST',headers: {} },status: 405 },
      { env: { QUALTRICS_API_TOKEN: null },req: { method: 'GET',headers: {} },status: 503 }
    ]) {
      await t.test(String(scenario.status),async subtest => {
        configureEnv(subtest,scenario.env);
        const fetch = subtest.mock.method(globalThis,'fetch',() => { throw new Error('Unexpected upstream call'); });
        const res = response();
        await handler(scenario.req,res);
        assert.equal(res.statusCode,scenario.status);
        assert.equal(fetch.mock.callCount(),0);
        assert.equal(res.headers['content-disposition'],undefined);
      });
    }
  });

  test(name+' keeps public access and server Honduras defaults when optional survey settings are absent',async t => {
    configureEnv(t,{
      DASHBOARD_ACCESS_CODE: 'SYNTHETIC_IGNORED_FOR_PUBLIC_HONDURAS',
      QUALTRICS_DATA_CENTER: null, QUALTRICS_SURVEY_ID: null, QUALTRICS_COURIER_SURVEY_ID: null
    });
    const calls = mockQualtrics(t);
    const res = response();
    await handler({ method: 'GET',headers: {} },res);
    assert.equal(res.statusCode,200);
    const base = 'https://iad1.qualtrics.com/API/v3/surveys/'+HONDURAS_SURVEY_IDS[name];
    assert.ok(calls.some(call => call.url === base));
    assert.ok(calls.some(call => call.url === base+'/export-responses'));
    await workbook(res.buffer);
  });

  test(name+' respects configured Honduras survey and datacenter overrides',async t => {
    const envKey = name === 'observations' ? 'QUALTRICS_SURVEY_ID' : 'QUALTRICS_COURIER_SURVEY_ID';
    configureEnv(t,{ [envKey]: 'SV_SYNTHETIC_OVERRIDE', QUALTRICS_DATA_CENTER: 'ca1' });
    const calls = mockQualtrics(t);
    const res = response();
    await handler({ method: 'GET',headers: {} },res);
    assert.equal(res.statusCode,200);
    assert.ok(calls.every(call => call.url.startsWith('https://ca1.qualtrics.com/API/v3/surveys/SV_SYNTHETIC_OVERRIDE')));
    await workbook(res.buffer);
  });

  test(name+' still downloads valid text cells if metadata is unavailable',async t => {
    configureEnv(t);
    const sample = fillSynthetic(nativeExport());
    mockQualtrics(t,{ csv: encodeNative(sample),metadata: { error: 'unavailable' },metadataStatus: 503 });
    t.mock.method(console,'warn',() => {});
    const res = response();
    await handler({ method: 'GET',headers: {} },res);
    assert.equal(res.statusCode,200);
    const result = await workbook(res.buffer);
    assert.deepEqual(cells(result.getWorksheet('Sheet0'),3,SYNTHETIC_SCHEMA.headers.length),expectedExcelValues(sample.rows[0]));
  });

  test(name+' rejects malformed upstream CSV before sending workbook headers',async t => {
    configureEnv(t);
    mockQualtrics(t,{ csv: 'Finished,ResponseId\r\nFinished,Response ID\r\nTrue,"unterminated' });
    t.mock.method(console,'error',() => {});
    const res = response();
    await handler({ method: 'GET',headers: {} },res);
    assert.equal(res.statusCode,502);
    assert.equal(res.headers['content-disposition'],undefined);
    assert.equal(res.buffer.length,0);
  });
}

test('displayed-observer workbook keeps numeric rank/count and literal observer text',async t => {
  configureEnv(t);
  const res = response();
  await observersDownload({ method: 'POST',headers: {},body: { rows: [{ observer: '=literal@example.test',count: 12 }] } },res);
  assert.equal(res.statusCode,200);
  assert.equal(res.headers['content-type'],XLSX_CONTENT_TYPE);
  assert.match(res.headers['content-disposition'],/ILI_Honduras_.*\.xlsx/);
  const result = await workbook(res.buffer),sheet = result.getWorksheet('Observers');
  assert.deepEqual(cells(sheet,1,3),['Rank','RecipientEmail','CompletedObservations']);
  assert.deepEqual(cells(sheet,2,3),[1,'=literal@example.test',12]);
  assert.equal(sheet.getCell(2,2).type,ExcelJS.ValueType.String);
});

test('displayed-observer validation bounds size and accepts only safe nonnegative integer counts',async t => {
  configureEnv(t);
  let res = response();
  await observersDownload({ method: 'GET',headers: {} },res);
  assert.equal(res.statusCode,405);
  for (const rows of [[],Array(5001).fill({ observer: 'SYNTHETIC',count: 1 }),[{ observer: 2,count: 1 }],[{ observer: 'x'.repeat(501),count: 1 }],[{ observer: 'SYNTHETIC',count: -1 }],[{ observer: 'SYNTHETIC',count: 1.5 }],[{ observer: 'SYNTHETIC',count: '1' }],[{ observer: 'SYNTHETIC',count: Infinity }],[{ observer: 'SYNTHETIC',count: Number.MAX_SAFE_INTEGER+1 }]]) {
    res = response();
    await observersDownload({ method: 'POST',headers: {},body: { rows } },res);
    assert.equal(res.statusCode,400);
    assert.equal(res.headers['content-disposition'],undefined);
  }
  res = response();
  await observersDownload({ method: 'POST',headers: {},body: '{not JSON' },res);
  assert.equal(res.statusCode,400);
});

test('displayed-observer endpoint preserves public Honduras access and zero counts',async t => {
  configureEnv(t,{ DASHBOARD_ACCESS_CODE: 'SYNTHETIC_IGNORED_FOR_PUBLIC_HONDURAS' });
  const res = response();
  await observersDownload({ method: 'POST',headers: {},body: { rows: [{ observer: 'SYNTHETIC',count: 0 }] } },res);
  assert.equal(res.statusCode,200);
  const result = await workbook(res.buffer);
  assert.deepEqual(cells(result.getWorksheet('Observers'),2,3),[1,'SYNTHETIC',0]);
});

test('generic workbook output preserves supplied number types and never interprets strings as formulas',async () => {
  const result = await workbook(await tableWorkbookBuffer({ sheetName: 'Synthetic',headers: ['Text','Count'],rows: [['=1+1',0],['000123',12]] }));
  assert.deepEqual(cells(result.getWorksheet('Synthetic'),2,2),['=1+1',0]);
  assert.deepEqual(cells(result.getWorksheet('Synthetic'),3,2),['000123',12]);
});

test('dashboard uses Honduras branding, Excel-only data downloads, and retains image ZIP',() => {
  const html = readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const readme = readFileSync(new URL('../README.md',import.meta.url),'utf8');
  assert.match(html,/Honduras/);
  assert.doesNotMatch(html,/Mexico|México|Argentina/);
  assert.match(html,/\.xlsx/);
  assert.doesNotMatch(html,/text\/csv|\.csv\b|id=["']dataFormat["']/);
  assert.match(html,/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(html,/signature\[0\]!==80/);
  assert.match(html,/signature\[1\]!==75/);
  assert.match(html,/\/api\/download-observers/);
  assert.match(html,/\/assets\/photo-downloads\.js/);
  const photoDownloads=readFileSync(new URL('../assets/photo-downloads.js',import.meta.url),'utf8');
  assert.match(photoDownloads,/\/api\/download-images/);
  assert.match(photoDownloads,/\.zip/);
  for (const surveyId of Object.values(HONDURAS_SURVEY_IDS)) assert.ok(readme.includes(surveyId));
});
