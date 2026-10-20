import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import crypto from 'node:crypto';
import handler, { sendPhotoArchive } from '../api/download-images.js';
import { createPhotoPlan, verifyPhotoPart, MAX_ARCHIVE_BYTES } from '../lib/photo-archives.js';

const originalFetch = globalThis.fetch;
const envKeys = ['QUALTRICS_API_TOKEN', 'QUALTRICS_SURVEY_ID', 'QUALTRICS_DATA_CENTER', 'DASHBOARD_ACCESS_CODE', 'QUALTRICS_PHOTO_QUESTION_ID'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const secret = 'synthetic-api-token';
const surveyId = 'SV_Honduras_Synthetic_Photos';

class ResponseSink extends Writable {
  constructor({ slow = false, fail = false } = {}) {
    super({ highWaterMark: 64 });
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
    this.chunks = [];
    this.slow = slow;
    this.fail = fail;
  }
  _write(chunk, encoding, callback) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    if (this.fail) return callback(new Error('Synthetic client disconnected'));
    if (this.slow) setImmediate(callback); else callback();
  }
  status(value) { this.statusCode = value; return this; }
  json(body) { this.jsonBody = body; return this; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
}
function request(method = 'GET', body, query = {}) {
  return Object.assign(new EventEmitter(), { method, body, query, headers: {} });
}
function row(index) {
  return {
    Finished: 'True', ResponseId: 'R_SYNTHETIC_' + index,
    RecipientEmail: 'observer@example.test', ExternalReference: 'Synthetic observation',
    QID17_FILE_ID: 'F_SYNTHETIC_' + index, QID17_FILE_NAME: 'photo_' + index + '.jpg'
  };
}
function plan(count = 2) {
  return createPhotoPlan(Array.from({ length: count }, (_, index) => row(index)), { secret, surveyId });
}
function setup() {
  process.env.QUALTRICS_API_TOKEN = secret;
  process.env.QUALTRICS_SURVEY_ID = surveyId;
  process.env.QUALTRICS_DATA_CENTER = 'iad1';
  delete process.env.DASHBOARD_ACCESS_CODE;
  delete process.env.QUALTRICS_PHOTO_QUESTION_ID;
}
test.beforeEach(setup);
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

test('public photo routes preserve method and environment checks', async () => {
  globalThis.fetch = async () => assert.fail('No upstream request expected');
  const wrongMethod = new ResponseSink();
  await handler(request('DELETE'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  delete process.env.QUALTRICS_API_TOKEN;
  const missingEnv = new ResponseSink();
  await handler(request('GET', undefined, { mode: 'manifest' }), missingEnv);
  assert.equal(missingEnv.statusCode, 503);
});

test('cached clients cannot silently save a giant or JSON response as a ZIP', async () => {
  globalThis.fetch = async () => assert.fail('Legacy request must not export photos');
  const response = new ResponseSink();
  await handler(request(), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.jsonBody.code, 'RELOAD_REQUIRED');
  assert.equal(response.headers['content-type'], undefined);
  assert.equal(response.headers['content-disposition'], undefined);
});

test('manifest exports one stable list once; signed split does not re-export Qualtrics', async () => {
  const records = Array.from({ length: 103 }, (_, index) => ({
    responseId: 'R_SYNTHETIC_' + index,
    values: { finished: true, recipientEmail: 'observer@example.test', QID17_FILE_ID: 'F_SYNTHETIC_' + index, QID17_FILE_NAME: 'photo.jpg' }
  }));
  let exportStarts = 0;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.headers['X-API-TOKEN'], secret);
    if (options.method === 'POST') {
      exportStarts++;
      assert.deepEqual(JSON.parse(options.body), { format: 'json', compress: false });
      return Response.json({ result: { progressId: 'progress' } });
    }
    if (String(url).endsWith('/progress')) return Response.json({ result: { status: 'complete', fileId: 'file' } });
    if (String(url).endsWith('/file/file')) return Response.json({ responses: records });
    assert.fail('Unexpected request ' + url);
  };
  const response = new ResponseSink();
  await handler(request('GET', undefined, { mode: 'manifest' }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.jsonBody.totalPhotos, 103);
  assert.equal(response.jsonBody.parts.length, 3);
  assert.equal(exportStarts, 1);
  assert.ok(!JSON.stringify(response.jsonBody).includes(secret));
  globalThis.fetch = async () => assert.fail('Split must reuse signed snapshot');
  const first = response.jsonBody.parts[0];
  const split = new ResponseSink();
  await handler(request('POST', { action: 'split', token: first.token }), split);
  assert.equal(split.statusCode, 200);
  const children = split.jsonBody.parts;
  assert.equal(children.length, 2);
  assert.equal(children.reduce((sum, part) => sum + part.photoCount, 0), first.photoCount);
  const originalPhotos = verifyPhotoPart(first.token, { secret, surveyId }).photos.map(photo => photo.fileId);
  assert.deepEqual(children.flatMap(child => verifyPhotoPart(child.token, { secret, surveyId }).photos.map(photo => photo.fileId)), originalPhotos);
});

test('invalid and expired plans fail before reading photos', async () => {
  globalThis.fetch = async () => assert.fail('No upstream request expected');
  for (const body of [undefined, '{', { action: 'unknown', token: 'bad' }, { action: 'download', token: 'bad' }]) {
    const response = new ResponseSink();
    await handler(request('POST', body), response);
    assert.ok([400, 403].includes(response.statusCode));
    assert.equal(response.headers['content-disposition'], undefined);
  }
  const expired = createPhotoPlan([row(0)], { secret, surveyId, now: Date.now() - 24 * 3600_000 });
  const response = new ResponseSink();
  await handler(request('POST', { action: 'download', token: expired.parts[0].token }), response);
  assert.equal(response.statusCode, 410);
  assert.equal(response.jsonBody.code, 'EXPIRED_PLAN');
});

test('download returns only a complete ZIP with byte count and matching SHA-256', async () => {
  const part = plan(3).parts[0];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers['X-API-TOKEN'], secret);
    const bytes = Buffer.from('Synthetic photo ' + calls.length + ', accent: á');
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } });
  };
  const response = new ResponseSink({ slow: true });
  await handler(request('POST', { action: 'download', token: part.token }), response);
  assert.equal(response.statusCode, 200);
  assert.ok(response.writableFinished);
  const bytes = Buffer.concat(response.chunks);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), part.photoCount + 1);
  assert.equal(response.headers['content-type'], 'application/zip');
  assert.equal(Number(response.headers['content-length']), bytes.length);
  assert.equal(Number(response.headers['x-archive-bytes']), bytes.length);
  assert.equal(response.headers['x-archive-sha256'], crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(url => url.startsWith('https://iad1.qualtrics.com/API/v3/surveys/' + surveyId + '/responses/')));
});

test('missing, HTML and interrupted images never receive ZIP success headers', async () => {
  const part = plan(2).parts[0];
  for (const kind of ['missing', 'html', 'interrupted']) {
    globalThis.fetch = async () => {
      if (kind === 'missing') return new Response('Unavailable', { status: 404 });
      if (kind === 'html') return new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('Synthetic interrupted upstream')); } }), { headers: { 'content-type': 'image/jpeg' } });
    };
    const response = new ResponseSink();
    await handler(request('POST', { action: 'download', token: part.token }), response);
    assert.equal(response.statusCode, 502, kind);
    assert.equal(response.jsonBody.code, 'PHOTO_UNAVAILABLE', kind);
    assert.equal(response.headers['content-type'], undefined, kind);
    assert.equal(response.headers['content-disposition'], undefined, kind);
    assert.equal(response.chunks.length, 0, kind);
  }
});

test('oversized batches request splitting rather than returning partial ZIP bytes', async () => {
  globalThis.fetch = async () => new Response('unused', { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_ARCHIVE_BYTES + 1) } });
  const response = new ResponseSink();
  await handler(request('POST', { action: 'download', token: plan(2).parts[0].token }), response);
  assert.equal(response.statusCode, 413);
  assert.equal(response.jsonBody.code, 'SPLIT_REQUIRED');
  assert.equal(response.chunks.length, 0);
  assert.equal(response.headers['content-disposition'], undefined);
});

test('delivery respects backpressure and propagates destination disconnects', async () => {
  const bytes = Buffer.alloc(256 * 1024);
  bytes.writeUInt32LE(0x06054b50, bytes.length - 22);
  const part = { filename: 'synthetic.zip', photos: [row(0)] };
  const complete = new ResponseSink({ slow: true });
  await sendPhotoArchive(bytes, part, complete, new AbortController().signal);
  assert.ok(complete.writableFinished);
  assert.ok(complete.chunks.length >= 4);
  assert.deepEqual(Buffer.concat(complete.chunks), bytes);
  const interrupted = new ResponseSink({ fail: true });
  await assert.rejects(sendPhotoArchive(bytes, part, interrupted, new AbortController().signal), /disconnected/);
  assert.ok(interrupted.destroyed);
  assert.equal(interrupted.writableFinished, false);
});

test('an already-cancelled platform request never starts a Qualtrics export', async () => {
  globalThis.fetch = async () => assert.fail('Cancelled requests must not export');
  const controller = new AbortController();
  controller.abort();
  const req = request('GET', undefined, { mode: 'manifest' });
  req.signal = controller.signal;
  const response = new ResponseSink();
  await handler(req, response);
  assert.equal(response.statusCode, 499);
  assert.equal(response.jsonBody.code, 'DOWNLOAD_CANCELLED');
});

test('manifest preserves public Honduras defaults and configured photo fields', async () => {
  delete process.env.QUALTRICS_SURVEY_ID;
  delete process.env.QUALTRICS_DATA_CENTER;
  process.env.DASHBOARD_ACCESS_CODE = 'ignored-for-public-Honduras';
  process.env.QUALTRICS_PHOTO_QUESTION_ID = 'QID52';
  let exports = 0;
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://iad1.qualtrics.com/API/v3/surveys/SV_9LXy32LyJuSlvgi/'));
    assert.equal(options.headers['X-API-TOKEN'], secret);
    if (options.method === 'POST') {
      exports++;
      return Response.json({ result: { progressId: 'configured-progress' } });
    }
    if (String(url).endsWith('/configured-progress')) return Response.json({ result: { status: 'complete', fileId: 'configured-file' } });
    if (String(url).endsWith('/configured-file/file')) return Response.json({ responses: [
      { responseId:'R_configured', values:{ finished:true, QID52_FILE_ID:'F_configured', QID52_FILE_NAME:'configured.jpg', QID17_FILE_ID:'F_wrong' } },
      { responseId:'R_blank', values:{ QID52_FILE_ID:'F_blank' } },
      { responseId:'R_false', values:{ finished:false, QID52_FILE_ID:'F_false' } }
    ] });
    assert.fail('Unexpected request ' + url);
  };
  const response = new ResponseSink();
  await handler(request('GET', undefined, { mode:'manifest' }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(exports, 1);
  assert.equal(response.jsonBody.totalPhotos, 1);
  assert.match(response.jsonBody.parts[0].filename, /^ILI_Honduras_vehicle_photos_.*_part-001\.zip$/);
  const part = verifyPhotoPart(response.jsonBody.parts[0].token, { secret, surveyId:'SV_9LXy32LyJuSlvgi' });
  assert.deepEqual(part.photos.map(photo=>photo.fileId), ['F_configured']);
});
