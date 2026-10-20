import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import observations from '../api/data.js';
import courierSummary from '../api/courier-summary.js';
import downloadObservations from '../api/download-raw-data.js';
import downloadCouriers from '../api/download-courier-data.js';
import downloadImages from '../api/download-images.js';
import session from '../api/session.js';
import ExcelJS from 'exceljs';

const observationId = 'SV_9LXy32LyJuSlvgi';
const courierId = 'SV_8e48NZfmjF2fFrM';
const envKeys = [
  'QUALTRICS_API_TOKEN', 'QUALTRICS_DATA_CENTER',
  'QUALTRICS_SURVEY_ID', 'QUALTRICS_COURIER_SURVEY_ID',
  'QUALTRICS_OPERATION_QUESTION_ID', 'QUALTRICS_VEHICLE_QUESTION_ID',
  'QUALTRICS_PHOTO_QUESTION_ID'
];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let fetchCalls;
let datasets;

function exportedRow(responseId, values = {}) {
  return { responseId, values };
}

function fixtureDatasets() {
  return {
    [observationId]: [
      exportedRow('R_device_gps', {
        finished: true,
        recipientEmail: 'observer@example.test',
        startDate: '2026-10-14T10:00:00Z',
        endDate: '2026-10-14T10:02:00Z',
        recordedDate: '2026-10-14T10:02:00Z',
        duration: 120,
        __js_GPS_Latitude: 14.0818,
        __js_GPS_Longitude: -87.2068,
        QID27: 1,
        QID8: 2,
        QID17_FILE_ID: 'F_synthetic',
        QID99: 'Paquete, delicado'
      }),
      exportedRow('R_ip_location_only', {
        finished: true,
        recipientEmail: 'observer@example.test',
        locationLatitude: 14.10,
        locationLongitude: -87.20,
        QID27: 2,
        QID8: 1
      }),
      exportedRow('R_unfinished_observation', {
        finished: false,
        __js_GPS_Latitude: 14.08,
        __js_GPS_Longitude: -87.20,
        QID17_FILE_ID: 'F_unfinished'
      }),
      exportedRow('R_missing_completion_observation', { QID27: 1 })
    ],
    [courierId]: [
      exportedRow('R_linked_courier', {
        finished: true,
        ObservationID: 'R_device_gps',
        Institution: 'Synthetic institution',
        QID1: 'Entrega, pequeña'
      }),
      exportedRow('R_unlinked_courier', { finished: true, ObservationID: '' }),
      exportedRow('R_unfinished_courier', { finished: false, ObservationID: 'R_device_gps' }),
      exportedRow('R_missing_completion_courier', { ObservationID: 'R_device_gps' })
    ]
  };
}

const questions = {
  QID27: { QuestionText: 'Operation', Choices: { 1: { Display: 'Delivery' }, 2: { Display: 'Pickup' } } },
  QID8: { QuestionText: 'Vehicle', Choices: { 1: { Display: 'Motorcycle' }, 2: { Display: 'Bicycle' } } },
  QID50: { QuestionText: 'Configured operation', Choices: { 1: { Display: 'Pickup' }, 2: { Display: 'Delivery' } } },
  QID51: { QuestionText: 'Configured vehicle', Choices: { 1: { Display: 'Motorcycle' }, 2: { Display: 'Bicycle' } } }
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// These are synthetic native exports, not a Honduras instrument schema.
function csvFixture(surveyId) {
  const rows = datasets[surveyId];
  const valueKeys = [...new Set(rows.flatMap(row => Object.keys(row.values || {})))].filter(key => key !== 'finished');
  const headers = ['ResponseId', 'Finished', ...valueKeys];
  const labels = headers.map(header => header === 'ResponseId' ? 'Response ID' : header === 'Finished' ? 'Finished' : questions[header]?.QuestionText || header);
  const records = [headers, labels];
  // Exercise both native variants: two header rows and an optional ImportId row.
  if (surveyId === courierId) records.push(headers.map(header => JSON.stringify({ ImportId: header === 'ResponseId' ? '_recordId' : header === 'Finished' ? 'finished' : header })));
  for (const row of rows) records.push(headers.map(header =>
    header === 'ResponseId' ? row.responseId : header === 'Finished' ? row.values?.finished : row.values?.[header]
  ));
  return { headers, labels, text: '\uFEFF' + records.map(record => record.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}

async function responseWorkbook(res) {
  const bytes = Buffer.concat(res.chunks);
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');
  return new ExcelJS.Workbook().xlsx.load(bytes);
}

function mockQualtricsFetch() {
  const formats = new Map();
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    fetchCalls.push({ url: String(url), options });
    assert.equal(parsed.hostname, 'iad1.qualtrics.com');
    assert.equal(options.headers?.['X-API-TOKEN'], 'synthetic-token-only');
    const match = parsed.pathname.match(/^\/API\/v3\/surveys\/([^/]+)(.*)$/);
    assert.ok(match, `Unexpected mock request path: ${parsed.pathname}`);
    const [, surveyId, path] = match;
    assert.ok(Object.hasOwn(datasets, surveyId), `Unexpected survey: ${surveyId}`);
    if (path === '') return jsonResponse({ result: { Questions: questions } });
    if (path === '/export-responses') {
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.ok(['json', 'csv'].includes(body.format), 'Only analytics JSON or native CSV should be requested');
      assert.deepEqual(body, body.format === 'csv' ? { format: 'csv', compress: false, useLabels: true, breakoutSets: false } : { format: 'json', compress: false });
      formats.set(surveyId, body.format);
      return jsonResponse({ result: { progressId: 'mock-progress' } });
    }
    if (path === '/export-responses/mock-progress') {
      return jsonResponse({ result: { status: 'complete', fileId: 'mock-file' } });
    }
    if (path === '/export-responses/mock-file/file') {
      if (formats.get(surveyId) === 'csv') return new Response(csvFixture(surveyId).text, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      return jsonResponse({ responses: datasets[surveyId] });
    }
    assert.fail(`Unexpected mock request path: ${parsed.pathname}`);
  };
}

function response() {
  return {
    headers: {},
    statusCode: undefined,
    body: undefined,
    chunks: [],
    headersSent: false,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.headersSent = true; this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    end(chunk) { if (chunk != null) this.write(chunk); this.ended = true; }
  };
}

function request(query = {}) {
  return { method: 'GET', query, headers: {} };
}

function exportStarts() {
  return fetchCalls.filter(call => call.options.method === 'POST').map(call => call.url);
}

describe('Honduras API integration with synthetic Qualtrics exports', { concurrency: false }, () => {
  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    process.env.QUALTRICS_API_TOKEN = 'synthetic-token-only';
    fetchCalls = [];
    datasets = fixtureDatasets();
    mockQualtricsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('observation and courier handlers export distinct Honduras surveys and exclude unfinished rows', async () => {
    const observationResponse = response();
    await observations(request(), observationResponse);
    assert.equal(observationResponse.statusCode, 200);
    assert.equal(observationResponse.body.summary.responses, 2);
    assert.deepEqual(observationResponse.body.observations.map(row => row.id), ['R_device_gps', 'R_ip_location_only']);

    const courierResponse = response();
    await courierSummary(request(), courierResponse);
    assert.equal(courierResponse.statusCode, 200);
    assert.equal(courierResponse.body.surveyId, courierId);
    assert.equal(courierResponse.body.summary.responses, 2);
    assert.equal(courierResponse.body.summary.linkedResponses, 1);
    assert.equal(courierResponse.body.summary.linkRate, 50);
    assert.deepEqual(exportStarts(), [
      `https://iad1.qualtrics.com/API/v3/surveys/${observationId}/export-responses`,
      `https://iad1.qualtrics.com/API/v3/surveys/${courierId}/export-responses`
    ]);
  });

  test('device GPS counts exclude IP-derived Qualtrics locations', async () => {
    const res = response();
    await observations(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary.gps, 1);
    assert.equal(res.body.points.length, 1);
    assert.equal(res.body.points[0].id, 'R_device_gps');
    assert.equal(res.body.points[0].lat, 14.0818);
    const ipOnly = res.body.observations.find(row => row.id === 'R_ip_location_only');
    assert.equal(ipOnly.lat, null);
    assert.equal(ipOnly.lon, null);
  });

  test('configured operation, vehicle, and photo fields drive filters and summaries', async () => {
    process.env.QUALTRICS_OPERATION_QUESTION_ID = 'QID50';
    process.env.QUALTRICS_VEHICLE_QUESTION_ID = 'QID51';
    process.env.QUALTRICS_PHOTO_QUESTION_ID = 'QID52';
    datasets[observationId] = [
      exportedRow('R_configured_match', {
        finished: true, QID50: 1, QID51: 2, QID52_FILE_ID: 'F_configured',
        QID27: 2, QID8: 1
      }),
      exportedRow('R_configured_other', {
        finished: true, QID50: 2, QID51: 1, QID17_FILE_ID: 'F_legacy'
      })
    ];
    const res = response();
    await observations(request({ operation: 'Pickup', vehicle: 'Bicycle' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary.totalResponses, 2);
    assert.equal(res.body.summary.responses, 1);
    assert.equal(res.body.summary.images, 1);
    assert.equal(res.body.summary.totalImages, 1);
    assert.deepEqual(res.body.filterOptions.operations, ['Delivery', 'Pickup']);
    assert.deepEqual(res.body.filterOptions.vehicles, ['Bicycle', 'Motorcycle']);
    assert.equal(res.body.observations[0].id, 'R_configured_match');
    assert.equal(res.body.observations[0].operation, 'Pickup');
    assert.equal(res.body.observations[0].vehicle, 'Bicycle');
    assert.equal(res.body.observations[0].hasPhoto, true);
  });

  test('observation Excel download retains native headers and labels with completed rows only', async () => {
    const expected = csvFixture(observationId);
    const res = response();
    await downloadObservations(request(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Disposition'], /filename="ILI_Honduras_observations_\d{4}-\d{2}-\d{2}\.xlsx"/);
    assert.equal(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.ended, true);
    const workbook = await responseWorkbook(res);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Sheet0', 'Data dictionary']);
    const sheet = workbook.getWorksheet('Sheet0');
    assert.deepEqual(sheet.getRow(1).values.slice(1), expected.headers);
    assert.deepEqual(sheet.getRow(2).values.slice(1), expected.labels);
    assert.equal(sheet.rowCount, 4);
    assert.deepEqual([sheet.getCell(3, 1).value, sheet.getCell(4, 1).value], ['R_device_gps', 'R_ip_location_only']);
    assert.equal(sheet.getCell(3, expected.headers.indexOf('QID99') + 1).value, 'Paquete, delicado');
    const dictionary = workbook.getWorksheet('Data dictionary');
    assert.equal(dictionary.rowCount, expected.headers.length + 1);
    assert.equal(dictionary.getCell(2, 3).value, 'ResponseId');
    assert.equal(dictionary.getCell(2, 4).value, 'Response ID');
    assert.deepEqual(exportStarts(), [`https://iad1.qualtrics.com/API/v3/surveys/${observationId}/export-responses`]);
  });

  test('courier Excel download retains native headers and labels with completed rows only', async () => {
    const expected = csvFixture(courierId);
    const res = response();
    await downloadCouriers(request(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Disposition'], /filename="ILI_Honduras_courier_survey_\d{4}-\d{2}-\d{2}\.xlsx"/);
    assert.equal(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.ended, true);
    const workbook = await responseWorkbook(res);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Sheet0', 'Data dictionary']);
    const sheet = workbook.getWorksheet('Sheet0');
    assert.deepEqual(sheet.getRow(1).values.slice(1), expected.headers);
    assert.deepEqual(sheet.getRow(2).values.slice(1), expected.labels);
    assert.equal(sheet.rowCount, 4, 'ImportId metadata must not appear among response rows');
    assert.deepEqual([sheet.getCell(3, 1).value, sheet.getCell(4, 1).value], ['R_linked_courier', 'R_unlinked_courier']);
    assert.equal(sheet.getCell(3, expected.headers.indexOf('ObservationID') + 1).value, 'R_device_gps');
    assert.equal(sheet.getCell(3, expected.headers.indexOf('QID1') + 1).value, 'Entrega, pequeña');
    const dictionary = workbook.getWorksheet('Data dictionary');
    assert.equal(dictionary.rowCount, expected.headers.length + 1);
    assert.equal(dictionary.getCell(2, 3).value, 'ResponseId');
    assert.equal(dictionary.getCell(2, 5).value, '_recordId');
    assert.deepEqual(exportStarts(), [`https://iad1.qualtrics.com/API/v3/surveys/${courierId}/export-responses`]);
  });

  test('data and download handlers accept public requests without a cookie', async () => {
    datasets[observationId] = [exportedRow('R_public_observation', { finished: true })];
    for (const handler of [observations, courierSummary, downloadObservations, downloadCouriers]) {
      const res = response();
      await handler(request(), res);
      assert.equal(res.statusCode, 200);
    }
    const imageResponse = response();
    await downloadImages(request({mode:'manifest'}), imageResponse);
    assert.equal(imageResponse.statusCode, 404);
    assert.deepEqual(imageResponse.body, { error: 'No uploaded vehicle images were found in completed responses.' });
    assert.equal(exportStarts().length, 5);
  });

  test('session reports public dashboard access without contacting Qualtrics', async () => {
    const res = response();
    await session(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { authenticated: true, protected: false, country: 'Honduras' });
    assert.equal(fetchCalls.length, 0);
  });

  test('all handlers reject unsupported methods before contacting Qualtrics', async () => {
    for (const handler of [observations, courierSummary, downloadObservations, downloadCouriers, downloadImages, session]) {
      const res = response();
      await handler({ method: 'DELETE', headers: {}, query: {} }, res);
      assert.equal(res.statusCode, 405);
      assert.deepEqual(res.body, { error: 'Method not allowed' });
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('Qualtrics API token remains required for all data and download handlers', async () => {
    delete process.env.QUALTRICS_API_TOKEN;
    for (const handler of [observations, courierSummary, downloadObservations, downloadCouriers, downloadImages]) {
      const res = response();
      await handler(request(), res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, /environment variables are not configured/);
    }
    assert.equal(fetchCalls.length, 0);
  });
});
