import archiver from 'archiver';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isFinished } from './qualtrics.js';
import { photoValue } from './config.js';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_PART_PHOTOS = 50;
const PART_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 128 * 1024;
const PHOTO_TIMEOUT_MS = 30000;

export class PhotoArchiveError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PhotoArchiveError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { return new PhotoArchiveError(status, code, message); }
function configured(secret, surveyId) {
  if (typeof secret !== 'string' || !secret || typeof surveyId !== 'string' || !surveyId || surveyId.length > 200) {
    throw fail(503, 'PHOTO_CONFIGURATION', 'Photo downloads are not configured.');
  }
}
function currentTime(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.');
  return now;
}
function text(value, maximum, required = false) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > maximum) {
    throw fail(502, 'PHOTO_METADATA', 'The photo list could not be prepared.');
  }
  return result;
}
function segment(value, fallback, limit) {
  const basename = String(value || fallback).split(/[\\/]/).pop() || fallback;
  let result = basename.replace(/[^A-Za-z0-9@._+-]+/g, '_').replace(/^\.+|\.+$/g, '') || fallback;
  if (result.length > limit) {
    const extension = result.match(/(\.[A-Za-z0-9]{1,10})$/)?.[1] ?? '';
    result = result.slice(0, limit - extension.length) + extension;
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = '_' + result;
  return result.replace(/\.+$/g, '') || fallback;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function partFilename(part) { return 'ILI_Honduras_vehicle_photos_' + part.date + '_part-' + part.id + '.zip'; }
function signature(payload, secret) { return crypto.createHmac('sha256', secret).update(payload).digest(); }
function signedPart(part, secret) {
  const payload = Buffer.from(JSON.stringify({
    version: 1, id: part.id, date: part.date, exp: part.exp, surveyId: part.surveyId, photos: part.photos
  })).toString('base64url');
  const token = payload + '.' + signature(payload, secret).toString('base64url');
  if (token.length > MAX_TOKEN_LENGTH) throw fail(502, 'PHOTO_METADATA', 'The photo list could not be prepared.');
  return { id: part.id, filename: partFilename(part), photoCount: part.photos.length, token };
}
function validatePart(part, surveyId, now) {
  if (!part || part.version !== 1 || !/^\d{3,9}[ab]{0,8}$/.test(part.id ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(part.date ?? '') || !Number.isSafeInteger(part.exp) ||
      typeof part.surveyId !== 'string' || part.surveyId !== surveyId ||
      !Array.isArray(part.photos) || !part.photos.length || part.photos.length > MAX_PART_PHOTOS) {
    throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.');
  }
  if (part.exp <= now) throw fail(410, 'PHOTO_PART_EXPIRED', 'This photo download has expired. Prepare the photo list again.');
  const identities = new Set(), paths = new Set();
  for (const photo of part.photos) {
    if (!photo || typeof photo !== 'object' || Array.isArray(photo) ||
        !['responseId','observer','externalReference','fileId','fileName','savedPath'].every(key => typeof photo[key] === 'string') ||
        !photo.responseId || photo.responseId.length > 200 || !photo.fileId || photo.fileId.length > 200 ||
        photo.observer.length > 500 || photo.externalReference.length > 1024 || photo.fileName.length > 500 ||
        !photo.savedPath || photo.savedPath.length > 160 || photo.savedPath.includes('\\') ||
        photo.savedPath.startsWith('/') || photo.savedPath.includes(':') ||
        photo.savedPath.split('/').some(value => !value || value === '.' || value === '..' || /[. ]$/.test(value))) {
      throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.');
    }
    const identity = photo.responseId + '\0' + photo.fileId;
    const path = photo.savedPath.toLowerCase();
    if (identities.has(identity) || paths.has(path)) throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.');
    identities.add(identity); paths.add(path);
  }
  return { version: 1, id: part.id, date: part.date, exp: part.exp, surveyId: part.surveyId, photos: part.photos, filename: partFilename(part) };
}

export function createPhotoPlan(rows, { secret, surveyId, now = Date.now() } = {}) {
  configured(secret, surveyId); currentTime(now);
  if (!Array.isArray(rows)) throw fail(502, 'PHOTO_METADATA', 'The photo list could not be prepared.');
  const source = rows.filter(isFinished).map(row => ({
    responseId: text(row.ResponseId, 200),
    observer: text(row.RecipientEmail, 500) || 'No_RecipientEmail',
    externalReference: text(row.ExternalReference, 1024),
    fileId: text(photoValue(row, 'id'), 200),
    fileName: text(photoValue(row, 'name'), 500) || 'image'
  })).filter(photo => photo.responseId && photo.fileId);
  source.sort((a, b) => compare(a.responseId, b.responseId) || compare(a.fileId, b.fileId) ||
    compare(a.observer, b.observer) || compare(a.fileName, b.fileName) || compare(a.externalReference, b.externalReference));
  const seen = new Set(), paths = new Set(), photos = [];
  for (const photo of source) {
    const identity = photo.responseId + '\0' + photo.fileId;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
    const folder = segment(photo.observer, 'No_RecipientEmail', 40);
    const name = segment(photo.fileName, 'image', 36);
    const stem = segment(photo.responseId, 'response', 24) + '__' + segment(photo.fileId, 'file', 18) + '__' + hash;
    let savedPath = folder + '/' + stem + '__' + name;
    let suffix = 1;
    while (paths.has(savedPath.toLowerCase())) savedPath = folder + '/' + stem + '__' + suffix++ + '__' + name;
    paths.add(savedPath.toLowerCase());
    photos.push({ ...photo, savedPath });
  }
  const exp = now + PART_TTL_MS, date = new Date(now).toISOString().slice(0, 10), parts = [];
  for (let offset = 0; offset < photos.length; offset += MAX_PART_PHOTOS) {
    parts.push(signedPart({ version: 1, id: String(parts.length + 1).padStart(3, '0'), date, exp, surveyId,
      photos: photos.slice(offset, offset + MAX_PART_PHOTOS) }, secret));
  }
  return { version: 1, totalPhotos: photos.length, expiresAt: new Date(exp).toISOString(), maxPartPhotos: MAX_PART_PHOTOS, parts };
}

export function verifyPhotoPart(token, { secret, surveyId, now = Date.now() } = {}) {
  configured(secret, surveyId); currentTime(now);
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
    throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.');
  }
  const [payload, digest] = token.split('.');
  const received = Buffer.from(digest, 'base64url'), expected = signature(payload, secret);
  if (received.length !== expected.length || received.toString('base64url') !== digest || !crypto.timingSafeEqual(received, expected)) {
    throw fail(403, 'INVALID_PHOTO_PART', 'The photo download request could not be verified.');
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw fail(400, 'INVALID_PHOTO_PART', 'The photo download request is invalid.'); }
  if (decoded?.surveyId !== surveyId) throw fail(403, 'INVALID_PHOTO_PART', 'The photo download request could not be verified.');
  return validatePart(decoded, surveyId, now);
}

export function splitPhotoPart(part, { secret, surveyId, now = Date.now() } = {}) {
  configured(secret, surveyId); currentTime(now);
  const valid = validatePart(part, surveyId, now);
  if (valid.photos.length < 2) throw fail(422, 'PHOTO_NOT_SPLITTABLE', 'This part contains one photo and cannot be split further.');
  const middle = Math.ceil(valid.photos.length / 2);
  return { parts: [
    signedPart({ ...valid, id: valid.id + 'a', photos: valid.photos.slice(0, middle) }, secret),
    signedPart({ ...valid, id: valid.id + 'b', photos: valid.photos.slice(middle) }, secret)
  ] };
}

function limitError(part, status) {
  if (part.photos.length > 1) return fail(status, 'SPLIT_REQUIRED', 'This ZIP part needs to be divided into smaller parts.');
  return status === 413
    ? fail(413, 'PHOTO_TOO_LARGE', 'This photo exceeds the ZIP size limit. Retrieve its original file from Qualtrics.')
    : fail(503, 'PHOTO_UNAVAILABLE', 'The photo could not be downloaded before the time limit. Try again.');
}
function cancelled() { return fail(499, 'DOWNLOAD_CANCELLED', 'The photo download was cancelled.'); }
function unavailable() { return fail(502, 'PHOTO_UNAVAILABLE', 'One photo could not be retrieved. Try this ZIP part again.'); }
function csvCell(value) {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? '"' + string.replace(/"/g, '""') + '"' : string;
}
function manifest(part) {
  const headers = ['ResponseId','RecipientEmail','ExternalReference','file_id','original_name','saved_path','status','error'];
  const rows = part.photos.map(photo => [
    photo.responseId, photo.observer === 'No_RecipientEmail' ? '' : photo.observer, photo.externalReference,
    photo.fileId, photo.fileName, photo.savedPath, 'downloaded', ''
  ]);
  return Buffer.from('\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}
function appendEntry(archive, source, name) {
  return new Promise((resolve, reject) => {
    if (archive.destroyed) return reject(archive.errored ?? unavailable());
    const cleanup = () => { archive.off('entry', onEntry); archive.off('error', onError); };
    const onEntry = entry => { if (entry.name === name) { cleanup(); resolve(); } };
    const onError = error => { cleanup(); reject(error); };
    archive.on('entry', onEntry); archive.once('error', onError);
    try { archive.append(source, { name, store: true }); } catch (error) { cleanup(); reject(error); }
  });
}

async function readPhoto(photo, { dataCenter, surveyId, token, fetchImpl, signal, deadline, remaining, part }) {
  const controller = new AbortController();
  let reader, response;
  const abort = () => controller.abort(signal.reason ?? cancelled());
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const remainingTime = Math.max(1, deadline - Date.now());
  const timeout = setTimeout(() => controller.abort(remainingTime <= PHOTO_TIMEOUT_MS ? limitError(part, 503) : unavailable()), Math.min(PHOTO_TIMEOUT_MS, remainingTime));
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => {
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
      reject(controller.signal.reason ?? cancelled());
    };
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  try {
    const url = 'https://' + dataCenter + '.qualtrics.com/API/v3/surveys/' + encodeURIComponent(surveyId) +
      '/responses/' + encodeURIComponent(photo.responseId) + '/uploaded-files/' + encodeURIComponent(photo.fileId);
    const pending = Promise.resolve().then(() => fetchImpl(url, {
      headers: { 'X-API-TOKEN': token, Accept: '*/*' }, signal: controller.signal
    }));
    pending.then(response => {
      if (controller.signal.aborted && response?.body) Promise.resolve(response.body.cancel()).catch(() => {});
    }, () => {});
    response = await Promise.race([pending, aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response?.ok) { if (response?.body) Promise.resolve(response.body.cancel()).catch(() => {}); throw unavailable(); }
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('html') || contentType.includes('json') || !response.body?.getReader) {
      if (response.body) Promise.resolve(response.body.cancel()).catch(() => {});
      throw unavailable();
    }
    const lengthHeader = response.headers.get('content-length');
    let declared = null;
    if (lengthHeader != null) {
      if (!/^\d+$/.test(lengthHeader.trim())) throw unavailable();
      declared = Number(lengthHeader);
      if (!Number.isSafeInteger(declared)) throw limitError(part, 413);
      if (declared > remaining) throw limitError(part, 413);
    }
    const identityEncoding = !response.headers.get('content-encoding') || response.headers.get('content-encoding').toLowerCase() === 'identity';
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      size += chunk.length;
      if (size > remaining) throw limitError(part, 413);
      chunks.push(chunk);
    }
    if (!size || (identityEncoding && declared !== null && declared !== size)) throw unavailable();
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (reader) Promise.resolve(reader.cancel()).catch(() => {});
    else if (response?.body) Promise.resolve(response.body.cancel()).catch(() => {});
    if (signal.aborted) throw signal.reason ?? cancelled();
    if (controller.signal.aborted) throw controller.signal.reason ?? unavailable();
    if (error instanceof PhotoArchiveError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', abortListener);
    if (reader) { try { reader.releaseLock(); } catch {} }
  }
}

export async function buildPhotoArchive(part, {
  dataCenter, surveyId, token, fetchImpl = fetch, signal, deadline = Date.now() + 150000
} = {}) {
  configured(token, surveyId);
  const valid = validatePart(part, surveyId, Date.now());
  if (typeof dataCenter !== 'string' || !/^[a-z0-9-]+$/i.test(dataCenter)) throw fail(503, 'PHOTO_CONFIGURATION', 'Photo downloads are not configured.');
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw limitError(valid, 503);
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const callerAbort = () => controller.abort(cancelled());
  if (signal) signal.addEventListener('abort', callerAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(limitError(valid, 503)), Math.max(1, deadline - Date.now()));
  const chunks = [];
  let bytes = 0, sourceBytes = 0;
  const archive = archiver('zip', { store: true });
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (bytes + chunk.length > MAX_ARCHIVE_BYTES) return callback(limitError(valid, 413));
      bytes += chunk.length; chunks.push(Buffer.from(chunk)); callback();
    }
  });
  const abort = () => {
    const reason = controller.signal.reason ?? cancelled();
    archive.destroy(reason); output.destroy(reason);
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  archive.on('warning', error => archive.destroy(error));
  const completion = pipeline(archive, output);
  // Attach rejection handling immediately, even while a photo is being fetched.
  completion.catch(error => {
    if (!controller.signal.aborted) controller.abort(error instanceof PhotoArchiveError ? error : unavailable());
  });
  try {
    for (const photo of valid.photos) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const buffer = await readPhoto(photo, { dataCenter, surveyId, token, fetchImpl,
        signal: controller.signal, deadline, remaining: MAX_ARCHIVE_BYTES - sourceBytes, part: valid });
      if (controller.signal.aborted) throw controller.signal.reason;
      sourceBytes += buffer.length;
      await appendEntry(archive, buffer, photo.savedPath);
    }
    await appendEntry(archive, manifest(valid), 'photo_manifest_part-' + valid.id + '.csv');
    await archive.finalize();
    await completion;
    if (controller.signal.aborted) throw controller.signal.reason;
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    controller.abort(error instanceof PhotoArchiveError ? error : unavailable());
    await completion.catch(() => {});
    chunks.length = 0;
    if (error instanceof PhotoArchiveError) throw error;
    throw controller.signal.reason ?? unavailable();
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', callerAbort);
    controller.signal.removeEventListener('abort', abort);
  }
}
