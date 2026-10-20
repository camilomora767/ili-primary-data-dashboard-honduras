import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MAX_ARCHIVE_BYTES, MAX_PART_PHOTOS, PhotoArchiveError,
  createPhotoPlan, verifyPhotoPart, splitPhotoPart, buildPhotoArchive
} from '../lib/photo-archives.js';
import { parseCsvRecords } from '../lib/csv.js';

const SECRET = 'synthetic-photo-test-secret';
const SURVEY_ID = 'SV_synthetic_photos';
const OPTIONS = { secret: SECRET, surveyId: SURVEY_ID };
function rows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ResponseId: 'R_synthetic_' + String(index).padStart(4, '0'),
    Finished: true,
    RecipientEmail: 'observer-' + (index % 3) + '@example.test',
    ExternalReference: 'SYNTHETIC_REFERENCE',
    QID17_FILE_ID: 'F_synthetic_' + String(index).padStart(4, '0'),
    QID17_FILE_NAME: 'synthetic-' + index + '.jpg'
  }));
}
function part(count = 1) {
  return verifyPhotoPart(createPhotoPlan(rows(count), OPTIONS).parts[0].token, OPTIONS);
}
function signed(payload) {
  const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return text + '.' + crypto.createHmac('sha256', SECRET).update(text).digest('base64url');
}
function errorIs(status, code) {
  return error => error instanceof PhotoArchiveError && error.status === status && error.code === code;
}
function photoResponse(buffer, extra = {}) {
  return new Response(buffer, { headers: {
    'Content-Type': 'image/jpeg', 'Content-Length': String(buffer.length), ...extra
  } });
}
function byteFixture(index, length = 8192) {
  const result = Buffer.alloc(length, (index * 37 + 11) % 251);
  result.write('SYNTHETIC PHOTO ' + index + '\n');
  return result;
}
function fixtureFetcher(part, length = 8192) {
  const byId = new Map(part.photos.map((photo, index) => [photo.fileId, byteFixture(index, length)]));
  const calls = [];
  return {
    calls, byId,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers['X-API-TOKEN'], SECRET);
      assert.equal(options.headers.Accept, '*/*');
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      assert.ok(byId.has(id));
      return photoResponse(byId.get(id));
    }
  };
}

// Independent ZIP reader: inspect the central directory, extract STORE bytes,
// and verify every CRC-32 and uncompressed size, rather than trusting PK bytes.
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function extractZip(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  let end = -1;
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65557); position--) {
    if (buffer.readUInt32LE(position) === 0x06054b50 &&
        position + 22 + buffer.readUInt16LE(position + 20) === buffer.length) { end = position; break; }
  }
  assert.notEqual(end, -1, 'The complete end-of-central-directory record must exist');
  assert.equal(buffer.readUInt16LE(end + 4), 0);
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  const count = buffer.readUInt16LE(end + 10);
  assert.equal(buffer.readUInt16LE(end + 8), count);
  const centralSize = buffer.readUInt32LE(end + 12);
  let position = buffer.readUInt32LE(end + 16);
  assert.equal(position + centralSize, end);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50);
    const method = buffer.readUInt16LE(position + 10);
    assert.equal(method, 0, 'Photo archives should STORE already-compressed images');
    const expectedCrc = buffer.readUInt32LE(position + 16);
    const compressed = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const local = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    assert.ok(!entries.has(name), 'No entry may overwrite a prior path');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const offset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const extracted = buffer.subarray(offset, offset + compressed);
    assert.equal(extracted.length, size);
    assert.equal(crc32(extracted), expectedCrc, 'CRC mismatch for ' + name);
    entries.set(name, extracted);
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, end);
  return entries;
}

test('photo plan is stable, completed-only, deduplicated, signed, and split into at most 50 photos', () => {
  const input = rows(61);
  input.push({ ...input[0] });
  input.push({ ...input[1], ResponseId: 'R_unfinished', Finished: false });
  input.push({ ResponseId: 'R_no_photo', Finished: true });
  const now = Date.UTC(2026, 9, 20, 12);
  const plan = createPhotoPlan(input, { ...OPTIONS, now });
  assert.equal(MAX_ARCHIVE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_PART_PHOTOS, 50);
  assert.equal(plan.version, 1);
  assert.equal(plan.totalPhotos, 61);
  assert.equal(plan.maxPartPhotos, 50);
  assert.equal(plan.expiresAt, new Date(now + 4 * 60 * 60 * 1000).toISOString());
  assert.deepEqual(plan.parts.map(value => value.photoCount), [50, 11]);
  assert.deepEqual(plan, createPhotoPlan(input.slice().reverse(), { ...OPTIONS, now }));
  assert.equal(plan.parts[0].id, '001');
  assert.equal(plan.parts[0].filename, 'ILI_Honduras_vehicle_photos_2026-10-20_part-001.zip');
  const decoded = plan.parts.map(value => verifyPhotoPart(value.token, { ...OPTIONS, now }));
  assert.equal(decoded.flatMap(value => value.photos).length, 61);
  assert.equal(new Set(decoded.flatMap(value => value.photos.map(photo => photo.responseId + '/' + photo.fileId))).size, 61);
});

test('photo aliases retain strict Honduras completed-response filtering', () => {
  const input = [
    { ResponseId: 'R_1', Q17_Id: 'F_1', Q17_Name: 'one.jpg' },
    { ResponseId: 'R_2', Finished: 'yes', Q17_ID: 'F_2', Q17_NAME: 'two.jpg' },
    { ResponseId: 'R_3', Finished: '0', QID17_FILE_ID: 'F_3' }
  ];
  const plan = createPhotoPlan(input, OPTIONS);
  assert.equal(plan.totalPhotos, 1);
  assert.deepEqual(verifyPhotoPart(plan.parts[0].token, OPTIONS).photos.map(value => value.fileId), ['F_2']);
  assert.deepEqual(createPhotoPlan([], OPTIONS).parts, []);
});

test('paths are safe for Windows extraction, bounded, and unique without case-sensitive overwrites', () => {
  const input = rows(4);
  input[0].RecipientEmail = 'CON';
  input[0].QID17_FILE_NAME = '../../NUL.jpg';
  input[1].RecipientEmail = 'observer@example.test';
  input[1].QID17_FILE_NAME = 'SAME.JPG';
  input[2].RecipientEmail = 'OBSERVER@example.test';
  input[2].QID17_FILE_NAME = 'same.jpg';
  input[3].RecipientEmail = 'a'.repeat(150) + '@example.test';
  input[3].QID17_FILE_NAME = 'x'.repeat(250) + '.jpg';
  input[3].ResponseId = 'R_' + 'x'.repeat(198);
  input[3].QID17_FILE_ID = 'F_' + 'x'.repeat(198);
  const decoded = verifyPhotoPart(createPhotoPlan(input, OPTIONS).parts[0].token, OPTIONS);
  assert.ok(decoded.photos.some(photo => photo.fileName === 'x'.repeat(250) + '.jpg'), 'The manifest metadata retains the full original filename');
  assert.equal(new Set(decoded.photos.map(value => value.savedPath.toLowerCase())).size, 4);
  for (const photo of decoded.photos) {
    assert.ok(photo.savedPath.length < 160);
    assert.ok(!photo.savedPath.includes('\\'));
    assert.ok(photo.savedPath.endsWith('.jpg') || photo.savedPath.endsWith('.JPG'));
    for (const component of photo.savedPath.split('/')) {
      assert.ok(component && component !== '.' && component !== '..');
      assert.doesNotMatch(component, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    }
  }
});

test('tokens reject tampering, another secret or survey, expiry, oversized payloads, and malformed fields', () => {
  const now = Date.now(), plan = createPhotoPlan(rows(2), { ...OPTIONS, now }), token = plan.parts[0].token;
  assert.throws(() => verifyPhotoPart(token, { ...OPTIONS, secret: 'another-secret', now }), errorIs(403,'INVALID_PHOTO_PART'));
  assert.throws(() => verifyPhotoPart(token, { ...OPTIONS, surveyId: 'SV_other', now }), errorIs(403,'INVALID_PHOTO_PART'));
  assert.throws(() => verifyPhotoPart('A' + token.slice(1), { ...OPTIONS, now }), errorIs(403,'INVALID_PHOTO_PART'));
  assert.throws(() => verifyPhotoPart(token, { ...OPTIONS, now: now + 4 * 60 * 60 * 1000 }), errorIs(410,'PHOTO_PART_EXPIRED'));
  assert.throws(() => verifyPhotoPart('x'.repeat(140000), OPTIONS), errorIs(400,'INVALID_PHOTO_PART'));
  const valid = verifyPhotoPart(token, { ...OPTIONS, now });
  for (const bad of [
    { ...valid, version: 2 },
    { ...valid, photos: Array(51).fill(valid.photos[0]) },
    { ...valid, photos: [{ ...valid.photos[0], savedPath: '../outside.jpg' }] },
    { ...valid, photos: [{ ...valid.photos[0], fileId: 5 }] },
    { ...valid, photos: [valid.photos[0], valid.photos[0]] }
  ]) assert.throws(() => verifyPhotoPart(signed(bad), { ...OPTIONS, now }), errorIs(400,'INVALID_PHOTO_PART'));
});

test('splitting creates two verifiable parts with exact coverage and retains the original expiry', () => {
  const original = part(5), result = splitPhotoPart(original, OPTIONS);
  const children = result.parts.map(value => verifyPhotoPart(value.token, OPTIONS));
  assert.deepEqual(children.map(value => value.id), ['001a','001b']);
  assert.deepEqual(children.map(value => value.photos.length), [3,2]);
  assert.deepEqual(children.flatMap(value => value.photos), original.photos);
  assert.ok(children.every(value => value.exp === original.exp && value.date === original.date));
  assert.throws(() => splitPhotoPart(part(1), OPTIONS), errorIs(422,'PHOTO_NOT_SPLITTABLE'));
});

test('a 50-photo archive extracts every exact payload and a complete success manifest', async () => {
  const decoded = part(50), fixture = fixtureFetcher(decoded);
  const buffer = await buildPhotoArchive(decoded, { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl: fixture.fetchImpl });
  assert.ok(buffer.length <= MAX_ARCHIVE_BYTES);
  const entries = extractZip(buffer);
  assert.equal(entries.size, 51);
  assert.equal(fixture.calls.length, 50);
  for (const photo of decoded.photos) assert.deepEqual(entries.get(photo.savedPath), fixture.byId.get(photo.fileId));
  const records = parseCsvRecords(entries.get('photo_manifest_part-001.csv').toString('utf8')).map(value => value.values);
  assert.equal(records.length, 51);
  assert.deepEqual(records[0], ['ResponseId','RecipientEmail','ExternalReference','file_id','original_name','saved_path','status','error']);
  assert.ok(records.slice(1).every(value => value[6] === 'downloaded' && value[7] === ''));
});

test('sequential readers do not open another upstream body before the previous body finishes', async () => {
  const decoded = part(5);
  let active = 0, maximum = 0;
  const fetchImpl = async () => {
    active++; maximum = Math.max(maximum, active);
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(128)); }
        else { active--; controller.close(); }
      }
    }), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '128' } });
  };
  extractZip(await buildPhotoArchive(decoded, { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl }));
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

test('HTTP errors, HTML, JSON, empty photos, mismatched length and broken bodies never produce partial ZIPs', async t => {
  const decoded = part(2);
  const cases = [
    () => new Response('not found', { status: 404 }),
    () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{"error":"invalid"}', { headers: { 'Content-Type': 'application/problem+json' } }),
    () => photoResponse(Buffer.alloc(0)),
    () => photoResponse(Buffer.from('abc'), { 'Content-Length': '20' }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.error(new Error('synthetic body failure')); } }), { headers: { 'Content-Type': 'image/jpeg' } })
  ];
  for (const [index, makeResponse] of cases.entries()) {
    await t.test(String(index), async () => {
      await assert.rejects(buildPhotoArchive(decoded, { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl: async () => makeResponse() }), errorIs(502,'PHOTO_UNAVAILABLE'));
    });
  }
});

test('a declared oversized photo requests a split, while one-photo parts return a clear size error', async () => {
  const oversized = async () => new Response(new Uint8Array(1), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(MAX_ARCHIVE_BYTES + 1) } });
  await assert.rejects(buildPhotoArchive(part(2), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl: oversized }), errorIs(413,'SPLIT_REQUIRED'));
  await assert.rejects(buildPhotoArchive(part(1), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl: oversized }), errorIs(413,'PHOTO_TOO_LARGE'));
});

test('actual output size includes ZIP and manifest overhead, not only source image bytes', async () => {
  const bytes = Buffer.alloc(MAX_ARCHIVE_BYTES - 100, 97);
  await assert.rejects(buildPhotoArchive(part(2), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET,
    fetchImpl: async () => photoResponse(bytes) }), errorIs(413,'SPLIT_REQUIRED'));
});

test('an already-expired deadline requests splitting before any upstream call', async () => {
  let calls = 0;
  await assert.rejects(buildPhotoArchive(part(2), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, deadline: Date.now() - 1,
    fetchImpl: async () => { calls++; throw new Error(); } }), errorIs(503,'SPLIT_REQUIRED'));
  assert.equal(calls, 0);
});

test('the deadline aborts a stalled fetch even when its implementation ignores AbortSignal', async () => {
  await assert.rejects(buildPhotoArchive(part(2), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET,
    deadline: Date.now() + 20, fetchImpl: () => new Promise(() => {}) }), errorIs(503,'SPLIT_REQUIRED'));
});

test('a per-photo timeout cancels stalled upstream work without returning partial bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstreamSignal;
  const pending = buildPhotoArchive(part(1), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET,
    fetchImpl: (url, options) => { upstreamSignal = options.signal; return new Promise(() => {}); } });
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(30001);
  await assert.rejects(pending, errorIs(502,'PHOTO_UNAVAILABLE'));
  assert.equal(upstreamSignal.aborted, true);
});

test('caller cancellation aborts and cancels an active photo reader', async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const pending = buildPhotoArchive(part(2), { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { 'Content-Type': 'image/jpeg' } }) });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, errorIs(499,'DOWNLOAD_CANCELLED'));
  assert.equal(bodyCancelled, true);
});

test('scale: 1663 synthetic 640-KiB photo payloads extract once each across valid bounded archives', {
  skip: process.env.PHOTO_ARCHIVE_SCALE !== '1', timeout: 180000
}, async () => {
  const plan = createPhotoPlan(rows(1663), OPTIONS);
  assert.equal(plan.parts.length, 34);
  let totalImageBytes = 0, photos = 0, peakRss = process.memoryUsage().rss;
  const seen = new Set();
  for (const planned of plan.parts) {
    const decoded = verifyPhotoPart(planned.token, OPTIONS);
    const fixture = fixtureFetcher(decoded, 640 * 1024);
    const buffer = await buildPhotoArchive(decoded, { dataCenter: 'iad1', surveyId: SURVEY_ID, token: SECRET, fetchImpl: fixture.fetchImpl });
    assert.ok(buffer.length <= MAX_ARCHIVE_BYTES);
    const entries = extractZip(buffer);
    for (const photo of decoded.photos) {
      assert.ok(!seen.has(photo.responseId));
      seen.add(photo.responseId);
      const extracted = entries.get(photo.savedPath), expected = fixture.byId.get(photo.fileId);
      assert.equal(crypto.createHash('sha256').update(extracted).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'));
      totalImageBytes += extracted.length; photos++;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  assert.equal(photos, 1663);
  assert.equal(seen.size, 1663);
  assert.ok(totalImageBytes > 1024 * 1024 * 1024);
  assert.ok(peakRss < 768 * 1024 * 1024, 'The complete >1 GiB export must not be held in memory at once');
});
