import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exportResponses, isFinished } from '../lib/qualtrics.js';
import { observationSurveyId } from '../lib/config.js';
import {
  MAX_ARCHIVE_BYTES, PhotoArchiveError, createPhotoPlan, verifyPhotoPart,
  splitPhotoPart, buildPhotoArchive
} from '../lib/photo-archives.js';

const CHUNK_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024;

export async function sendPhotoArchive(buffer, part, res, signal) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 ||
      buffer.length > MAX_ARCHIVE_BYTES ||
      buffer.readUInt32LE(buffer.length - 22) !== 0x06054b50) {
    throw new Error('Archive was not finalized');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + part.filename + '"');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('X-Archive-Bytes', String(buffer.length));
  res.setHeader('X-Archive-SHA256', crypto.createHash('sha256').update(buffer).digest('hex'));
  res.setHeader('X-Archive-Photos', String(part.photos.length));
  // Explicit writes keep delivery streamed on Vercel, even though the bounded
  // archive is fully finalized before any ZIP response headers are sent.
  async function* chunks() {
    for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
      yield buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length));
    }
  }
  await pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: CHUNK_BYTES }), res, { signal });
}

function requestBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new PhotoArchiveError(400, 'INVALID_REQUEST', 'Photo request is too large.');
    try { body = JSON.parse(body); } catch { throw new PhotoArchiveError(400, 'INVALID_REQUEST', 'Invalid photo request.'); }
  }
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES ||
      !['download', 'split'].includes(body.action) || typeof body.token !== 'string') {
    throw new PhotoArchiveError(400, 'INVALID_REQUEST', 'Invalid photo request.');
  }
  return body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.QUALTRICS_API_TOKEN;
  const dataCenter = process.env.QUALTRICS_DATA_CENTER || 'iad1';
  const surveyId = observationSurveyId();
  if (!token || !surveyId) return res.status(503).json({ error: 'Qualtrics environment variables are not configured' });

  const controller = new AbortController();
  const onAborted = () => controller.abort(new PhotoArchiveError(499, 'DOWNLOAD_CANCELLED', 'The photo download was cancelled.'));
  const onClose = () => { if (!res.writableFinished) onAborted(); };
  req.once?.('aborted', onAborted);
  if (req.signal?.aborted) onAborted();
  else req.signal?.addEventListener('abort', onAborted, { once: true });
  res.once?.('close', onClose);
  try {
    controller.signal.throwIfAborted();
    if (req.method === 'GET') {
      if (req.query?.mode !== 'manifest') {
        return res.status(409).json({ code: 'RELOAD_REQUIRED', error: 'Reload the dashboard to download photos in complete ZIP parts.' });
      }
      const rows = (await exportResponses({ dataCenter, surveyId, token })).filter(isFinished);
      if (controller.signal.aborted) throw controller.signal.reason;
      const plan = createPhotoPlan(rows, { secret: token, surveyId });
      if (!plan.totalPhotos) return res.status(404).json({ error: 'No uploaded vehicle images were found in completed responses.' });
      return res.status(200).json(plan);
    }

    const body = requestBody(req);
    const part = verifyPhotoPart(body.token, { secret: token, surveyId });
    if (body.action === 'split') {
      return res.status(200).json(splitPhotoPart(part, { secret: token, surveyId }));
    }
    const buffer = await buildPhotoArchive(part, {
      dataCenter, surveyId, token, signal: controller.signal,
      deadline: Date.now() + 120_000
    });
    await sendPhotoArchive(buffer, part, res, controller.signal);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      // A graceful end here would turn an interrupted transfer into a saved,
      // corrupt ZIP. Destroy it; the client also verifies size and SHA-256.
      if (!res.destroyed) res.destroy(error);
      return;
    }
    const known = error instanceof PhotoArchiveError;
    console.error('Photo archive request failed', { code: known ? error.code : 'ARCHIVE_FAILED' });
    return res.status(known ? error.status : 502).json({
      code: known ? (error.code === 'PHOTO_PART_EXPIRED' ? 'EXPIRED_PLAN' : error.code) : 'ARCHIVE_FAILED',
      error: known ? error.message : 'Unable to prepare this photo ZIP. Retry this part or use smaller ZIPs.'
    });
  } finally {
    req.removeListener?.('aborted', onAborted);
    req.signal?.removeEventListener('abort', onAborted);
    res.removeListener?.('close', onClose);
  }
}
