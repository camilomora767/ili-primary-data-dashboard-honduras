import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { MAX_ARCHIVE_BYTES, PhotoDownloadController, readVerifiedArchive } from '../assets/photo-downloads.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Real, small, uncompressed ZIPs: photos plus one manifest file.
function zipFixture(photoCount = 1) {
  const local = [], directory = [];
  let offset = 0;
  const entries = Array.from({ length: photoCount }, (_, index) => [`photos/photo-${index}.txt`, `synthetic photo ${index}`]);
  entries.push(['manifest.json', JSON.stringify({ photoCount })]);
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(value), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const part = (id = '001', photoCount = 1) => ({ id, photoCount, token: `token-${id}`, filename: `ILI_Honduras_vehicle_photos_2026-10-20_part-${id}.zip` });
const plan = parts => ({ version: 1, totalPhotos: parts.reduce((sum, entry) => sum + entry.photoCount, 0), maxPartPhotos: 50, expiresAt: '2099-10-20T12:00:00Z', parts });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function zipResponse(bytes, { expected = bytes.length, headers = {}, body = bytes } = {}) {
  return new Response(body, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(expected), 'X-Archive-Bytes': String(expected), 'X-Archive-SHA256': hash(bytes), ...headers } });
}

function controllerFor(parts, behavior = () => zipResponse(zipFixture()), extra = {}) {
  const requests = [], saves = [];
  const controller = new PhotoDownloadController({
    cryptoImpl: webcrypto,
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('?mode=manifest')) return jsonResponse(plan(parts));
      const request = JSON.parse(options.body); requests.push(request);
      return behavior(request, options, requests);
    },
    saveImpl: async (blob, filename) => { saves.push({ filename, bytes: Buffer.from(await blob.arrayBuffer()) }); },
    ...extra
  });
  return { controller, requests, saves };
}

test('valid ZIP is streamed with progress and verified before producing a Blob', async () => {
  const bytes = zipFixture(2), progress = [], phases = [];
  let cursor = 0;
  const body = new ReadableStream({ pull(stream) {
    if (cursor === bytes.length) { stream.close(); return; }
    const next = Math.min(cursor + 17, bytes.length); stream.enqueue(bytes.subarray(cursor, next)); cursor = next;
  } });
  const result = await readVerifiedArchive(zipResponse(bytes, { body }), part('001', 2), { cryptoImpl: webcrypto, onProgress: (...value) => progress.push(value), onPhase: phase => phases.push(phase) });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  assert.equal(result.sha256, hash(bytes));
  assert.equal(result.byteLength, bytes.length);
  assert.ok(progress.length > 2);
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  assert.deepEqual(phases, ['checking']);
});

test('truncated, oversized, corrupt, wrong-type and incomplete ZIPs are rejected', async t => {
  const good = zipFixture();
  const badEnd = Buffer.from(good); badEnd.writeUInt32LE(0, badEnd.length - 22);
  const badDirectory = Buffer.from(good); badDirectory.writeUInt32LE(0, good.readUInt32LE(good.length - 6));
  const cases = [
    ['HTML error body', () => zipResponse(good, { headers: { 'Content-Type': 'text/html' } })],
    ['missing size', () => zipResponse(good, { headers: { 'X-Archive-Bytes': '' } })],
    ['over 64 MiB', () => zipResponse(good, { expected: MAX_ARCHIVE_BYTES + 1 })],
    ['conflicting lengths', () => zipResponse(good, { headers: { 'Content-Length': String(good.length - 1) } })],
    ['truncated stream', () => zipResponse(good, { body: good.subarray(0, -1) })],
    ['more bytes than declared', () => zipResponse(good, { body: Buffer.concat([good, Buffer.from('x')]) })],
    ['wrong hash', () => zipResponse(good, { headers: { 'X-Archive-SHA256': '0'.repeat(64) } })],
    ['missing hash', () => zipResponse(good, { headers: { 'X-Archive-SHA256': '' } })],
    ['missing EOCD', () => zipResponse(badEnd)],
    ['corrupt central directory', () => zipResponse(badDirectory)],
    ['wrong expected photo count', () => zipResponse(good), part('001', 2)]
  ];
  for (const [name, response, archivePart = part()] of cases) await t.test(name, async () => {
    await assert.rejects(readVerifiedArchive(response(), archivePart, { cryptoImpl: webcrypto }));
  });
});

test('controller never saves a truncated ZIP and exposes an individual retry', async () => {
  const bytes = zipFixture(); let tries = 0;
  const { controller, saves } = controllerFor([part()], () => ++tries === 1 ? zipResponse(bytes, { body: bytes.subarray(0, -5) }) : zipResponse(bytes));
  await controller.refresh();
  assert.equal(await controller.downloadPart('001'), false);
  assert.equal(saves.length, 0);
  assert.equal(controller.state.parts[0].status, 'error');
  assert.match(controller.state.parts[0].message, /interrupted/i);
  assert.equal(await controller.downloadPart('001'), true);
  assert.equal(saves.length, 1);
  assert.equal(controller.state.parts[0].status, 'completed');
});

test('Download all is sequential, stops on failure, and retries remaining parts without replaying completed parts', async () => {
  const parts = [part('001'), part('002'), part('003')];
  let active = 0, maxActive = 0, secondTries = 0;
  const saves = [];
  const { controller, requests } = controllerFor(parts, async request => {
    active++; maxActive = Math.max(active, maxActive);
    if (request.token === 'token-002' && secondTries++ === 0) { active--; return jsonResponse({ error: 'Photo service unavailable.', code: 'PHOTO_UNAVAILABLE' }, 503); }
    return zipResponse(zipFixture());
  }, { saveImpl: async (blob, filename) => { await blob.arrayBuffer(); await Promise.resolve(); saves.push(filename); active--; } });
  await controller.refresh();
  assert.equal(await controller.downloadAll(), false);
  assert.deepEqual(requests.map(request => request.token), ['token-001', 'token-002']);
  assert.deepEqual(controller.state.parts.map(entry => entry.status), ['completed', 'error', 'ready']);
  assert.equal(await controller.downloadAll(), true);
  assert.deepEqual(requests.map(request => request.token), ['token-001', 'token-002', 'token-002', 'token-003']);
  assert.deepEqual(saves, parts.map(entry => entry.filename));
  assert.equal(maxActive, 1);
  assert.ok(controller.state.parts.every(entry => entry.status === 'completed'));
});

test('Stop cancels an active stream, preserves completed parts, and resumes safely', async () => {
  const parts = [part('001'), part('002')];
  let controller, shouldStop = true, cancelled = false;
  const setup = controllerFor(parts, request => {
    const bytes = zipFixture();
    if (request.token === 'token-002' && shouldStop) {
      const body = new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 10)); }, cancel() { cancelled = true; } });
      return zipResponse(bytes, { body });
    }
    return zipResponse(bytes);
  }, { onChange: state => {
    const current = state.parts.find(entry => entry.id === '002');
    if (shouldStop && current?.received > 0 && current.status === 'downloading') { shouldStop = false; controller.stop(); }
  } });
  controller = setup.controller;
  await controller.refresh();
  assert.equal(await controller.downloadAll(), false);
  assert.equal(cancelled, true);
  assert.deepEqual(controller.state.parts.map(entry => entry.status), ['completed', 'stopped']);
  assert.equal(setup.saves.length, 1);
  assert.equal(await controller.downloadAll(), true);
  assert.deepEqual(setup.requests.map(request => request.token), ['token-001', 'token-002', 'token-002']);
  assert.equal(setup.saves.length, 2);
});

test('SPLIT_REQUIRED automatically replaces a large part and downloads its children', async () => {
  const children = [part('001a'), part('001b')];
  const { controller, requests, saves } = controllerFor([part('001', 2)], request => {
    if (request.action === 'split') return jsonResponse({ parts: children });
    if (request.token === 'token-001') return jsonResponse({ error: 'Make this part smaller.', code: 'SPLIT_REQUIRED' }, 413);
    return zipResponse(zipFixture());
  });
  await controller.refresh();
  assert.equal(await controller.downloadAll(), true);
  assert.deepEqual(requests.map(request => [request.action, request.token]), [['download', 'token-001'], ['split', 'token-001'], ['download', 'token-001a'], ['download', 'token-001b']]);
  assert.deepEqual(controller.state.parts.map(entry => entry.id), ['001a', '001b']);
  assert.deepEqual(saves.map(save => save.filename), children.map(entry => entry.filename));
});

test('manual splitting retains all photos and invalid child lists are rejected', async () => {
  const initial = part('001', 3), children = [part('001a', 1), part('001b', 2)];
  const { controller, saves } = controllerFor([initial], () => jsonResponse({ parts: children }));
  await controller.refresh();
  assert.equal(await controller.split('001'), true);
  assert.equal(controller.state.parts.reduce((sum, entry) => sum + entry.photoCount, 0), 3);
  assert.equal(saves.length, 0);
  const bad = controllerFor([initial], () => jsonResponse({ parts: [part('001a'), part('001b')] }));
  await bad.controller.refresh();
  assert.equal(await bad.controller.split('001'), false);
  assert.deepEqual(bad.controller.state.parts.map(entry => entry.id), ['001']);
  assert.match(bad.controller.state.message, /inconsistent/i);
});

test('expired plans and unsplittable single photos show actionable errors without saving', async () => {
  for (const code of ['EXPIRED_PLAN', 'SPLIT_REQUIRED']) {
    const { controller, requests, saves } = controllerFor([part()], () => jsonResponse({ error: 'Unavailable.', code }, 409));
    await controller.refresh();
    assert.equal(await controller.downloadPart('001'), false);
    assert.equal(saves.length, 0);
    assert.equal(requests.length, 1);
    assert.match(controller.state.message, code === 'EXPIRED_PLAN' ? /expired.*refresh/i : /one-photo.*cannot be split/i);
  }
});

test('a stop during checksum verification cannot trigger a save', async () => {
  let controller;
  const setup = controllerFor([part()], () => zipResponse(zipFixture()), { onChange: state => {
    if (state.parts[0]?.status === 'checking' && !controller.abortController?.signal.aborted) controller.stop();
  } });
  controller = setup.controller;
  await controller.refresh();
  assert.equal(await controller.downloadAll(), false);
  assert.equal(setup.saves.length, 0);
  assert.equal(controller.state.parts[0].status, 'stopped');
});

test('manifest validation rejects inconsistent plans without replacing an existing valid list', async () => {
  let tries = 0;
  const setup = controllerFor([part()], () => zipResponse(zipFixture()), { fetchImpl: async () => {
    const result = plan([part()]); if (tries++ > 0) result.totalPhotos = 2;
    return jsonResponse(result);
  } });
  await setup.controller.refresh();
  assert.equal(await setup.controller.refresh(), false);
  assert.equal(setup.controller.state.parts[0].id, '001');
  assert.equal(setup.controller.state.hasPlan, true);
  assert.equal(setup.saves.length, 0);
});
test('an oversized declared archive is cancelled before any response body is buffered', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const response = zipResponse(zipFixture(), { expected: MAX_ARCHIVE_BYTES + 1, body });
  await assert.rejects(readVerifiedArchive(response, part(), { cryptoImpl: webcrypto }), error => error.code === 'SPLIT_REQUIRED');
  assert.equal(cancelled, true);
});