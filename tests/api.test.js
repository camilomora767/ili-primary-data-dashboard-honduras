import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import observations from '../api/data.js';
import courierSummary from '../api/courier-summary.js';
import downloadObservations from '../api/download-raw-data.js';
import downloadCouriers from '../api/download-courier-data.js';
import { setAccessCookie } from '../lib/auth.js';

const observationId = 'SV_9LXy32LyJuSlvgi';
const courierId = 'SV_8e48NZfmjF2fFrM';
const envKeys = [
  'DASHBOARD_ACCESS_CODE', 'QUALTRICS_API_TOKEN', 'QUALTRICS_DATA_CENTER',
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

function mockQualtricsFetch() {
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
      assert.deepEqual(JSON.parse(options.body), { format: 'json', compress: false });
      return jsonResponse({ result: { progressId: 'mock-progress' } });
    }
    if (path === '/export-responses/mock-progress') {
      return jsonResponse({ result: { status: 'complete', fileId: 'mock-file' } });
    }
    if (path === '/export-responses/mock-file/file') {
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
    write(chunk) { this.chunks.push(String(chunk)); },
    end() { this.ended = true; }
  };
}

function request(query = {}) {
  const res = response();
  setAccessCookie(res);
  return { method: 'GET', query, headers: { cookie: res.headers['Set-Cookie'].split(';')[0] } };
}

function exportStarts() {
  return fetchCalls.filter(call => call.options.method === 'POST').map(call => call.url);
}

describe('Honduras API integration with synthetic Qualtrics exports', { concurrency: false }, () => {
  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    process.env.DASHBOARD_ACCESS_CODE = 'synthetic-dashboard-code';
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

  test('raw observation download uses the Honduras instrument and filename with completed rows only', async () => {
    const res = response();
    await downloadObservations(request(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Disposition'], /filename="ILI_Honduras_raw_observations_\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.ended, true);
    const csv = res.chunks.join('');
    assert.ok(csv.startsWith('\uFEFF'));
    assert.ok(csv.includes('R_device_gps'));
    assert.ok(csv.includes('R_ip_location_only'));
    assert.ok(csv.includes('"Paquete, delicado"'));
    assert.ok(!csv.includes('R_unfinished_observation'));
    assert.ok(!csv.includes('R_missing_completion_observation'));
    assert.deepEqual(exportStarts(), [`https://iad1.qualtrics.com/API/v3/surveys/${observationId}/export-responses`]);
  });

  test('raw courier download uses the Honduras courier instrument and filename with completed rows only', async () => {
    const res = response();
    await downloadCouriers(request(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Disposition'], /filename="ILI_Honduras_courier_survey_\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(res.ended, true);
    const csv = res.chunks.join('');
    assert.ok(csv.includes('ObservationID'));
    assert.ok(csv.includes('R_linked_courier'));
    assert.ok(csv.includes('R_unlinked_courier'));
    assert.ok(csv.includes('"Entrega, pequeña"'));
    assert.ok(!csv.includes('R_unfinished_courier'));
    assert.ok(!csv.includes('R_missing_completion_courier'));
    assert.deepEqual(exportStarts(), [`https://iad1.qualtrics.com/API/v3/surveys/${courierId}/export-responses`]);
  });

  test('all tested data handlers reject unauthenticated requests before calling Qualtrics', async () => {
    for (const handler of [observations, courierSummary, downloadObservations, downloadCouriers]) {
      const res = response();
      await handler({ method: 'GET', headers: {}, query: {} }, res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'Authentication required' });
    }
    assert.equal(fetchCalls.length, 0);
  });
});
