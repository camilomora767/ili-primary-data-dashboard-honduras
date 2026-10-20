export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export class PhotoDownloadError extends Error {
  constructor(message, code = 'DOWNLOAD_FAILED') { super(message); this.name = 'PhotoDownloadError'; this.code = code; }
}
const stopped = () => new DOMException('Download stopped.', 'AbortError');
const checkStopped = signal => { if (signal?.aborted) throw stopped(); };
const fail = (message, code = 'INVALID_ARCHIVE') => { throw new PhotoDownloadError(message, code); };

async function responseError(response) {
  let body;
  try { body = await response.json(); } catch { /* A proxy may return an HTML error. */ }
  return new PhotoDownloadError(body?.error || `Download failed (${response.status}). Retry this part.`, body?.code || 'DOWNLOAD_FAILED');
}
function byteHeader(value, label) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(`The ZIP has no valid ${label}. Retry this part.`);
  return Number(value);
}

// Read a single bounded archive. No Blob or download is created until every check passes.
export async function readVerifiedArchive(response, part, { signal, onProgress = () => {}, onPhase = () => {}, cryptoImpl = globalThis.crypto } = {}) {
  if (!response.ok) throw await responseError(response);
  let expected, hash, reader;
  try {
    checkStopped(signal);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['application/zip', 'application/x-zip-compressed'].includes(mime)) fail('The server did not return a ZIP file. Retry this part.');
    expected = byteHeader(response.headers.get('x-archive-bytes'), 'archive size');
    if (expected > MAX_ARCHIVE_BYTES) fail('This ZIP is too large. Make smaller ZIPs for this part.', 'SPLIT_REQUIRED');
    if (expected < 22) fail('The ZIP is incomplete. Retry this part.');
    const contentLength = response.headers.get('content-length');
    if (contentLength != null && byteHeader(contentLength, 'content length') !== expected) fail('The ZIP size headers disagree. Retry this part.');
    hash = response.headers.get('x-archive-sha256') || '';
    if (!/^[a-f\d]{64}$/i.test(hash)) fail('The ZIP has no valid checksum. Retry this part.');
    if (!cryptoImpl?.subtle?.digest) fail('Your browser cannot verify this ZIP. Open this page over HTTPS in a current browser.', 'VERIFICATION_UNAVAILABLE');
    reader = response.body?.getReader();
    if (!reader) fail('Your browser cannot stream this ZIP. Try a current browser.', 'VERIFICATION_UNAVAILABLE');
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
  const chunks = [];
  let received = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    onProgress(0, expected);
    for (;;) {
      checkStopped(signal);
      const { done, value } = await reader.read();
      checkStopped(signal);
      if (done) break;
      received += value.byteLength;
      if (received > expected || received > MAX_ARCHIVE_BYTES) fail('The ZIP exceeded its declared size. No file was saved. Retry this part.');
      chunks.push(value);
      onProgress(received, expected);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (received !== expected) fail('The ZIP download was interrupted. No file was saved. Retry this part.');
  checkStopped(signal);
  onPhase('checking');
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  checkStopped(signal);
  const actualHash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (actualHash !== hash.toLowerCase()) fail('The ZIP checksum did not match. No file was saved. Retry this part.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 20, true) !== 0) fail('The ZIP is missing its closing record. No file was saved. Retry this part.');
  const entries = part.photoCount + 1; // Photos plus the archive manifest.
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== entries || view.getUint16(end + 10, true) !== entries) fail('The ZIP photo count did not match this part. No file was saved. Retry this part.');
  const centralSize = view.getUint32(end + 12, true), centralStart = view.getUint32(end + 16, true);
  if (centralStart + centralSize !== end || view.getUint32(0, true) !== 0x04034b50) fail('The ZIP directory is incomplete. No file was saved. Retry this part.');
  let cursor = centralStart;
  for (let entry = 0; entry < entries; entry++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('The ZIP directory is incomplete. No file was saved. Retry this part.');
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor !== end) fail('The ZIP directory size did not match. No file was saved. Retry this part.');
  checkStopped(signal);
  return { blob: new Blob([bytes], { type: 'application/zip' }), byteLength: received, sha256: actualHash };
}

function validatedParts(parts, maxPhotos = 50) {
  if (!Array.isArray(parts)) fail('The photo list is invalid. Refresh the list.', 'INVALID_PLAN');
  const ids = new Set();
  return parts.map(part => {
    if (!part || typeof part.id !== 'string' || !/^[\w-]+$/.test(part.id) || ids.has(part.id) || typeof part.token !== 'string' || !part.token || typeof part.filename !== 'string' || !/^[^/\\\r\n]+\.zip$/i.test(part.filename) || !Number.isSafeInteger(part.photoCount) || part.photoCount < 1 || part.photoCount > maxPhotos) fail('The photo list is invalid. Refresh the list.', 'INVALID_PLAN');
    ids.add(part.id);
    return { id: part.id, filename: part.filename, photoCount: part.photoCount, token: part.token, status: 'ready', received: 0, expected: 0, message: '' };
  });
}

export async function saveArchive(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  try {
    anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    // Let the browser start its download, then release this part before the next one.
    await new Promise(resolve => setTimeout(resolve, 1000));
  } finally { anchor.remove(); URL.revokeObjectURL(url); }
}

export class PhotoDownloadController {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), saveImpl = saveArchive, cryptoImpl = globalThis.crypto, onChange = () => {}, endpoint = '/api/download-images' } = {}) {
    this.fetchImpl = fetchImpl; this.saveImpl = saveImpl; this.cryptoImpl = cryptoImpl; this.onChange = onChange; this.endpoint = endpoint;
    this.state = { hasPlan: false, parts: [], totalPhotos: 0, expiresAt: null, busy: false, status: 'idle', message: 'Prepare the photo list to begin.', activeId: null };
    this.abortController = null;
  }
  notify() { this.onChange(this.state); }
  async run(task) {
    if (this.state.busy) return false;
    this.state.busy = true; this.state.status = 'working';
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.notify();
    try { await task(signal); return true; }
    catch (error) {
      this.state.status = signal.aborted || error.name === 'AbortError' ? 'stopped' : 'error';
      this.state.message = this.state.status === 'stopped' ? 'Stopped. Resume remaining parts or retry any part below.' : error.code === 'EXPIRED_PLAN' ? 'This photo list expired. Refresh the list to continue.' : String(error.message || error);
      return false;
    } finally {
      this.state.busy = false; this.state.activeId = null; this.abortController = null; this.notify();
    }
  }
  stop() {
    if (!this.state.busy) return;
    this.state.message = 'Stopping…'; this.abortController?.abort(); this.notify();
  }
  async jsonRequest(body, signal) {
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
  refresh() {
    return this.run(async signal => {
      this.state.message = 'Preparing the photo list…'; this.notify();
      const response = await this.fetchImpl(this.endpoint + '?mode=manifest', { cache: 'no-store', signal });
      if (!response.ok) throw await responseError(response);
      const plan = await response.json(); checkStopped(signal);
      if (plan.version !== 1 || !Number.isSafeInteger(plan.totalPhotos) || plan.totalPhotos < 0 || !Number.isInteger(plan.maxPartPhotos) || plan.maxPartPhotos < 1 || plan.maxPartPhotos > 50 || !Number.isFinite(Date.parse(plan.expiresAt))) fail('The photo list is invalid. Refresh the list.', 'INVALID_PLAN');
      const parts = validatedParts(plan.parts, plan.maxPartPhotos);
      if (parts.reduce((sum, part) => sum + part.photoCount, 0) !== plan.totalPhotos) fail('The photo list count is inconsistent. Refresh the list.', 'INVALID_PLAN');
      Object.assign(this.state, { hasPlan: true, parts, totalPhotos: plan.totalPhotos, expiresAt: plan.expiresAt, status: 'ready', message: parts.length ? 'Choose Download all parts, or download individual parts below.' : 'No photos are available in completed observations.' });
    });
  }
  async splitPart(part, signal) {
    if (part.photoCount <= 1) fail('This part contains one photo and cannot be split further. Retry it or refresh the list.', 'SINGLE_PHOTO_LIMIT');
    part.status = 'splitting'; part.message = 'Making smaller ZIPs…'; this.notify();
    const result = await this.jsonRequest({ action: 'split', token: part.token }, signal); checkStopped(signal);
    const children = validatedParts(result.parts);
    const otherIds = new Set(this.state.parts.filter(item => item !== part).map(item => item.id));
    if (children.length < 2 || children.some(child => child.photoCount >= part.photoCount || otherIds.has(child.id)) || children.reduce((sum, child) => sum + child.photoCount, 0) !== part.photoCount) fail('The smaller photo list is inconsistent. Refresh the list.', 'INVALID_PLAN');
    const index = this.state.parts.indexOf(part);
    if (index < 0) fail('The photo list changed. Refresh the list.', 'INVALID_PLAN');
    this.state.parts.splice(index, 1, ...children); this.notify();
    return children;
  }
  async downloadOne(part, signal) {
    checkStopped(signal);
    this.state.activeId = part.id; this.state.message = `Downloading part ${part.id} (${part.photoCount} photo${part.photoCount === 1 ? '' : 's'})…`;
    Object.assign(part, { status: 'preparing', message: 'Preparing this ZIP…', received: 0, expected: 0 }); this.notify();
    try {
      const response = await this.fetchImpl(this.endpoint, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', token: part.token }), signal });
      const archive = await readVerifiedArchive(response, part, { signal, cryptoImpl: this.cryptoImpl,
        onProgress: (received, expected) => { Object.assign(part, { status: 'downloading', message: 'Downloading…', received, expected }); this.notify(); },
        onPhase: () => { part.status = 'checking'; part.message = 'Verifying ZIP…'; this.notify(); }
      });
      checkStopped(signal);
      await this.saveImpl(archive.blob, part.filename);
      Object.assign(part, { status: 'completed', message: 'Verified · sent to your browser', received: archive.byteLength, expected: archive.byteLength }); this.notify();
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') { part.status = 'stopped'; part.message = 'Stopped. Retry this part to start it again.'; this.notify(); throw stopped(); }
      if (error.code === 'SPLIT_REQUIRED' && part.photoCount > 1) {
        try {
          const children = await this.splitPart(part, signal);
          for (const child of children) await this.downloadOne(child, signal);
          return;
        } catch (splitError) {
          if (this.state.parts.includes(part)) { part.status = signal.aborted ? 'stopped' : 'error'; part.message = String(splitError.message || splitError); this.notify(); }
          throw splitError;
        }
      }
      part.status = 'error';
      part.message = error.code === 'SPLIT_REQUIRED' ? 'This one-photo ZIP is too large to download. It cannot be split further.' : error.code === 'EXPIRED_PLAN' ? 'This photo list expired. Refresh the list.' : String(error.message || error);
      this.notify(); throw new PhotoDownloadError(part.message, error.code);
    }
  }
  downloadPart(id) {
    return this.run(async signal => {
      const part = this.state.parts.find(item => item.id === id);
      if (!part) fail('Choose a part from the current photo list.', 'INVALID_PLAN');
      await this.downloadOne(part, signal);
      this.state.status = 'ready'; this.state.message = 'ZIP verified and sent to your browser. You can download another part below.';
    });
  }
  downloadAll() {
    return this.run(async signal => {
      if (!this.state.hasPlan) fail('Prepare the photo list first.', 'INVALID_PLAN');
      // Splits replace a parent in this live list; completed children are skipped.
      for (let index = 0; index < this.state.parts.length; index++) {
        const part = this.state.parts[index];
        if (part.status !== 'completed') await this.downloadOne(part, signal);
        checkStopped(signal);
      }
      this.state.status = 'ready'; this.state.message = 'All ZIP parts were verified and sent to your browser. Check your downloads folder.';
    });
  }
  split(id) {
    return this.run(async signal => {
      const part = this.state.parts.find(item => item.id === id);
      if (!part) fail('Choose a part from the current photo list.', 'INVALID_PLAN');
      try { await this.splitPart(part, signal); }
      catch (error) { part.status = signal.aborted ? 'stopped' : 'error'; part.message = String(error.message || error); throw error; }
      this.state.status = 'ready'; this.state.message = 'Smaller ZIPs are ready. Download them individually or resume all parts.';
    });
  }
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MiB' : Math.round(bytes / 1024) + ' KiB';
}

export function mountPhotoDownloads(panel, options = {}) {
  const doc = panel.ownerDocument;
  const element = (tag, text, className) => { const node = doc.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, action) => { const node = element('button', text, 'btn'); node.type = 'button'; node.addEventListener('click', action); return node; };
  panel.replaceChildren();
  const head = element('div', '', 'panel-head'), heading = element('div');
  const title = element('h2', 'Download vehicle photos'); title.id = 'photoDownloadsTitle'; heading.append(title);
  const summary = element('div', '', 'eyebrow'); heading.append(summary); head.append(heading, button('Hide', () => { panel.hidden = true; }));
  const note = element('p', 'Your browser may ask to allow multiple downloads. Keep this page open to resume. Extract all ZIP parts into the same folder.', 'photo-note');
  const actions = element('div', '', 'photo-actions');
  const all = button('Download all parts', () => { void controller.downloadAll(); }); all.classList.add('primary');
  const stop = button('Stop', () => controller.stop());
  const refresh = button('Refresh list', () => { void controller.refresh(); });
  actions.append(all, stop, refresh);
  const message = element('p', '', 'photo-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const list = element('ol', '', 'photo-parts');
  panel.append(head, note, actions, message, list);
  const rows = new Map(); let ids = '';
  function render(state) {
    const completed = state.parts.filter(part => part.status === 'completed').length;
    summary.textContent = state.hasPlan ? `${state.totalPhotos} photos · ${state.parts.length} ZIP part${state.parts.length === 1 ? '' : 's'} · ${completed} verified and sent` : 'Small ZIP parts with verification before each download';
    all.disabled = state.busy || !state.parts.length || completed === state.parts.length;
    all.textContent = completed && completed < state.parts.length ? 'Resume remaining parts' : 'Download all parts';
    stop.disabled = !state.busy; refresh.disabled = state.busy;
    message.textContent = state.message; message.classList.toggle('photo-error', state.status === 'error');
    const nextIds = state.parts.map(part => part.id).join('|');
    if (nextIds !== ids) {
      ids = nextIds; const nodes = [];
      for (const part of state.parts) {
        const item = element('li', '', 'photo-part'), info = element('div', '', 'photo-info');
        const name = element('strong', part.filename), detail = element('div', '', 'photo-detail');
        const progress = element('progress'); progress.setAttribute('aria-label', `ZIP part ${part.id} download progress`);
        info.append(name, detail, progress);
        const controls = element('div', '', 'photo-row-actions');
        const download = button('Download', () => { void controller.downloadPart(part.id); });
        const split = button('Make smaller ZIPs', () => { void controller.split(part.id); });
        controls.append(download, split); item.append(info, controls); nodes.push(item);
        rows.set(part.id, { item, detail, progress, download, split });
      }
      for (const key of rows.keys()) if (!state.parts.some(part => part.id === key)) rows.delete(key);
      list.replaceChildren(...nodes);
    }
    for (const part of state.parts) {
      const row = rows.get(part.id);
      row.item.dataset.status = part.status;
      row.detail.textContent = `${part.photoCount} photo${part.photoCount === 1 ? '' : 's'} · ${part.message || 'Ready'}${part.expected ? ` · ${formatBytes(part.received)} / ${formatBytes(part.expected)}` : ''}`;
      row.progress.hidden = !['downloading', 'checking'].includes(part.status);
      row.progress.max = part.expected || 1; row.progress.value = part.received;
      row.download.disabled = state.busy;
      row.download.textContent = part.status === 'completed' ? 'Download again' : ['error', 'stopped'].includes(part.status) ? 'Retry' : 'Download';
      row.split.disabled = state.busy || part.photoCount <= 1;
    }
  }
  const controller = new PhotoDownloadController({ ...options, onChange: render });
  render(controller.state);
  return { controller, async open() { panel.hidden = false; if (!controller.state.hasPlan && !controller.state.busy) await controller.refresh(); } };
}