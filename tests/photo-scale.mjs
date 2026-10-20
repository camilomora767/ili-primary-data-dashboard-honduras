// Standalone scale verification, intentionally excluded from npm test.
// Run: node --expose-gc tests/photo-scale.mjs (Python 3 must be available).
// Synthetic binary payloads only; no network or Qualtrics credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPhotoPlan, verifyPhotoPart, buildPhotoArchive, MAX_ARCHIVE_BYTES, MAX_PART_PHOTOS } from '../lib/photo-archives.js';
const PHOTO_COUNT = 1663, PHOTO_BYTES = 640 * 1024, EXPECTED_PARTS = 34;
const PYTHON = process.env.PHOTO_ZIP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(workspace, '.zip-scale-output');
const runDirectory = path.resolve(outputRoot, 'run-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid);
const statePath = path.join(runDirectory, 'validated.jsonl'), reportPath = path.join(outputRoot, 'scale-report.json');
const secret = 'synthetic-scale-signature-key', surveyId = 'SV_SYNTHETIC_PHOTO_SCALE';
const started = performance.now();
let peakRssBytes = process.memoryUsage().rss;
const sampleRss = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); };
const sampler = setInterval(sampleRss, 20);
sampler.unref();
function safeOutputFile(file) {
  const resolved = path.resolve(file);
  assert.equal(path.dirname(resolved), runDirectory);
  assert.ok(runDirectory.startsWith(outputRoot + path.sep));
  assert.ok(outputRoot.startsWith(workspace + path.sep));
  return resolved;
}
async function removeValidatedFile(file) {
  const resolved = safeOutputFile(file), details = await fs.lstat(resolved);
  assert.ok(details.isFile() && !details.isSymbolicLink());
  assert.ok(/\.(?:zip|expected\.json)$/.test(resolved));
  await fs.unlink(resolved);
}
function identity(index) {
  const padded = String(index).padStart(6, '0');
  return { index, responseId:'R_'+padded, fileId:'F_'+padded, fileName:'photo_'+padded+'.jpg',
    observer:'observer'+String(index%27).padStart(2,'0')+'@example.test', externalReference:'synthetic-'+padded };
}
function payload(index) {
  return Buffer.alloc(PHOTO_BYTES, crypto.createHash('sha256').update('synthetic-photo-v1:'+index).digest());
}
const PYTHON_VALIDATOR = "\nimport csv, hashlib, io, json, os, struct, sys, zipfile, zlib\nmode = sys.argv[1]\ndef require(condition, message):\n    if not condition: raise AssertionError(message)\ndef identity(index):\n    padded = str(index).zfill(6)\n    response_id, file_id = \"R_\" + padded, \"F_\" + padded\n    observer = \"observer\" + str(index % 27).zfill(2) + \"@example.test\"\n    filename = \"photo_\" + padded + \".jpg\"\n    suffix = hashlib.sha256((response_id + \"\\0\" + file_id).encode()).hexdigest()[:12]\n    saved_path = observer + \"/\" + response_id + \"__\" + file_id + \"__\" + suffix + \"__\" + filename\n    return response_id, file_id, observer, filename, saved_path, \"synthetic-\" + padded\ndef synthetic(index, size):\n    digest = hashlib.sha256((\"synthetic-photo-v1:\" + str(index)).encode()).digest()\n    return (digest * ((size + len(digest) - 1) // len(digest)))[:size]\nif mode == \"part\":\n    zip_path, expectation_path, state_path = sys.argv[2:5]\n    with open(expectation_path, encoding=\"utf-8\") as handle: expected = json.load(handle)\n    photo_size, indices, part_id = expected[\"photoBytes\"], expected[\"indices\"], expected[\"partId\"]\n    zip_bytes = os.path.getsize(zip_path)\n    require(zip_bytes <= expected[\"maxArchiveBytes\"], \"ZIP exceeds size cap\")\n    with open(zip_path, \"rb\") as handle:\n        handle.seek(-22, os.SEEK_END)\n        eocd = handle.read(22)\n    require(eocd[:4] == b\"PK\\x05\\x06\" and struct.unpack(\"<H\", eocd[20:22])[0] == 0, \"Missing final ZIP EOCD\")\n    manifest_name = \"photo_manifest_part-\" + part_id + \".csv\"\n    expected_names = [identity(index)[4] for index in indices] + [manifest_name]\n    with zipfile.ZipFile(zip_path) as archive:\n        require(archive.testzip() is None, \"zipfile.testzip CRC failure\")\n        names = archive.namelist()\n        require(len(names) == len(set(names)), \"Duplicate ZIP name\")\n        require(sorted(names) == sorted(expected_names), \"Names/count do not match independent expectations\")\n        require(all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist()), \"Entries must use STORE\")\n        rows = list(csv.DictReader(io.StringIO(archive.read(manifest_name).decode(\"utf-8-sig\"), newline=\"\")))\n        require(len(rows) == len(indices), \"Manifest count mismatch\")\n        require(list(rows[0]) == [\"ResponseId\",\"RecipientEmail\",\"ExternalReference\",\"file_id\",\"original_name\",\"saved_path\",\"status\",\"error\"], \"Manifest headers mismatch\")\n        by_path = {row[\"saved_path\"]: row for row in rows}\n        require(len(by_path) == len(indices), \"Duplicate manifest path\")\n        for index in indices:\n            response_id, file_id, observer, filename, saved_path, reference = identity(index)\n            info, data = archive.getinfo(saved_path), archive.read(saved_path)\n            require(info.file_size == photo_size and len(data) == photo_size, \"Photo size mismatch\")\n            require((zlib.crc32(data) & 0xffffffff) == info.CRC, \"Independent CRC mismatch\")\n            require(hashlib.sha256(data).digest() == hashlib.sha256(synthetic(index, photo_size)).digest(), \"SHA256 mismatch\")\n            require(by_path[saved_path] == {\"ResponseId\":response_id,\"RecipientEmail\":observer,\n                \"ExternalReference\":reference,\"file_id\":file_id,\"original_name\":filename,\n                \"saved_path\":saved_path,\"status\":\"downloaded\",\"error\":\"\"}, \"Manifest fields mismatch\")\n    result = {\"partId\":part_id,\"photoCount\":len(indices),\"sourceBytes\":len(indices)*photo_size,\n        \"zipBytes\":zip_bytes,\"indices\":indices,\"crcPassed\":True,\"sha256Passed\":True,\n        \"manifestPassed\":True,\"namesPassed\":True,\"eocdPassed\":True}\n    with open(state_path, \"a\", encoding=\"utf-8\") as handle:\n        handle.write(json.dumps(result, separators=(\",\",\":\")) + \"\\n\")\n    print(json.dumps({key:value for key,value in result.items() if key != \"indices\"}, separators=(\",\",\":\")))\nelif mode == \"final\":\n    state_path, count, parts = sys.argv[2:5]\n    with open(state_path, encoding=\"utf-8\") as handle: rows = [json.loads(line) for line in handle if line.strip()]\n    require(len(rows) == int(parts) and len({row[\"partId\"] for row in rows}) == int(parts), \"Wrong or duplicate part count\")\n    indices = [index for row in rows for index in row[\"indices\"]]\n    require(len(indices) == int(count) and sorted(indices) == list(range(1,int(count)+1)), \"Photos missing/repeated\")\n    require(all(row[\"crcPassed\"] and row[\"sha256Passed\"] and row[\"manifestPassed\"] and row[\"namesPassed\"] and row[\"eocdPassed\"] for row in rows), \"Incomplete validation\")\n    print(json.dumps({\"validatedParts\":len(rows),\"validatedPhotos\":len(indices),\n        \"sourceBytes\":sum(row[\"sourceBytes\"] for row in rows),\n        \"totalZipBytes\":sum(row[\"zipBytes\"] for row in rows),\n        \"maxZipBytes\":max(row[\"zipBytes\"] for row in rows),\n        \"photoCountsByPart\":[row[\"photoCount\"] for row in rows],\n        \"crcValidation\":\"Python zipfile.testzip and independent zlib.crc32 passed\",\n        \"sha256Validation\":\"Independent expected-payload SHA256 passed for every image\",\n        \"manifestValidation\":\"Exact headers, fields, paths, counts and cross-part coverage passed\",\n        \"eocdValidation\":\"Final end-of-central-directory record present in every ZIP\"}, separators=(\",\",\":\")))\nelse: raise ValueError(\"Unknown validation mode\")\n";
async function python(...args) {
  return await new Promise((resolve,reject) => {
    const child = spawn(PYTHON, ['-c',PYTHON_VALIDATOR,...args], { cwd:workspace, windowsHide:true });
    let stdout='', stderr='';
    child.stdout.setEncoding('utf8').on('data',chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data',chunk => { stderr += chunk; });
    child.once('error',reject);
    child.once('exit',code => {
      if (code !== 0) return reject(new Error('Independent Python validation failed ('+code+'): '+stderr));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(new Error('Invalid Python result: '+stdout,{cause:error})); }
    });
  });
}
try {
  await fs.mkdir(runDirectory,{recursive:true});
  const rows = Array.from({length:PHOTO_COUNT},(_,offset) => {
    const photo = identity(offset+1);
    return { Finished:'True',ResponseId:photo.responseId,RecipientEmail:photo.observer,
      ExternalReference:photo.externalReference,QID17_FILE_ID:photo.fileId,QID17_FILE_NAME:photo.fileName };
  });
  const plan = createPhotoPlan(rows,{secret,surveyId});
  assert.equal(MAX_PART_PHOTOS,50);
  assert.equal(plan.totalPhotos,PHOTO_COUNT);
  assert.equal(plan.parts.length,EXPECTED_PARTS);
  const seenFetches = new Set();
  const fetchImpl = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname,'synthetic.qualtrics.com');
    const match = parsed.pathname.match(/^\/API\/v3\/surveys\/SV_SYNTHETIC_PHOTO_SCALE\/responses\/R_(\d{6})\/uploaded-files\/F_(\d{6})$/);
    assert.ok(match,'Unexpected mocked URL');
    assert.equal(match[1],match[2]);
    const index=Number(match[1]);
    assert.ok(index >= 1 && index <= PHOTO_COUNT && !seenFetches.has(index),'Invalid/duplicate photo fetch');
    seenFetches.add(index);
    return new Response(payload(index),{headers:{'Content-Type':'image/jpeg','Content-Length':String(PHOTO_BYTES)}});
  };
  for (let offset=0;offset<plan.parts.length;offset+=1) {
    const signed=plan.parts[offset], part=verifyPhotoPart(signed.token,{secret,surveyId});
    const indices=part.photos.map(photo => Number(photo.responseId.slice(2)));
    assert.deepEqual(indices,Array.from({length:Math.min(50,PHOTO_COUNT-offset*50)},(_,index)=>offset*50+index+1));
    const zipPath=safeOutputFile(path.join(runDirectory,signed.filename));
    const expectationPath=safeOutputFile(path.join(runDirectory,'part-'+part.id+'.expected.json'));
    let buffer=await buildPhotoArchive(part,{dataCenter:'synthetic',surveyId,token:'synthetic-not-a-real-token',fetchImpl,deadline:Date.now()+150000});
    sampleRss();
    await fs.writeFile(zipPath,buffer,{flag:'wx'});
    buffer=null;
    await fs.writeFile(expectationPath,JSON.stringify({partId:part.id,indices,photoBytes:PHOTO_BYTES,maxArchiveBytes:MAX_ARCHIVE_BYTES}),{flag:'wx'});
    const validated=await python('part',zipPath,expectationPath,statePath);
    await removeValidatedFile(zipPath);
    await removeValidatedFile(expectationPath);
    if(global.gc) global.gc();
    sampleRss();
    console.log(JSON.stringify({progress:String(offset+1)+'/'+plan.parts.length,...validated}));
  }
  assert.equal(seenFetches.size,PHOTO_COUNT);
  const independent=await python('final',statePath,String(PHOTO_COUNT),String(EXPECTED_PARTS));
  const report={passed:true,syntheticOnly:true,photoCount:PHOTO_COUNT,photoBytes:PHOTO_BYTES,
    plannedParts:plan.parts.length,maxPartPhotos:MAX_PART_PHOTOS,archiveCapBytes:MAX_ARCHIVE_BYTES,...independent,
    peakNodeRssBytes:Math.max(peakRssBytes,process.resourceUsage().maxRSS*1024),
    elapsedSeconds:Number(((performance.now()-started)/1000).toFixed(3)),
    python:PYTHON,temporaryZipFilesRetained:0,script:path.join(workspace,'tests','photo-scale.mjs'),partValidationRecords:statePath};
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({reportPath,...report}));
} finally { clearInterval(sampler); }
