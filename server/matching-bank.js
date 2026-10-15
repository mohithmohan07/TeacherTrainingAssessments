// Explicit source-confirmed banks are separate from grading and paper labels.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import db, { UPLOADS_DIR } from './db.js';
import { addPaper, allPapers, paperLabelsFrom, isPdf } from './papers.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 400, userMessage: message }); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
db.exec(`CREATE TABLE IF NOT EXISTS matching_banks (
 id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, paper_ids_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')));
 CREATE TABLE IF NOT EXISTS matching_bank_selections (
 school_id INTEGER NOT NULL REFERENCES schools(id), test_id INTEGER NOT NULL REFERENCES tests(id),
 bank_id TEXT NOT NULL REFERENCES matching_banks(id), PRIMARY KEY(school_id,test_id));`);

export function matchingBankInfo(schoolId, testId) {
  const selected = db.prepare('SELECT bank_id FROM matching_bank_selections WHERE school_id=? AND test_id=?').get(schoolId,testId);
  if (!selected) return null;
  const bank = db.prepare('SELECT * FROM matching_banks WHERE id=?').get(selected.bank_id);
  if (!bank) fail('The selected question-paper bank is missing. No library fallback is allowed.');
  let manifest, paperIds;
  try { manifest = JSON.parse(bank.manifest_json); paperIds = JSON.parse(bank.paper_ids_json); } catch { fail('The selected question-paper bank record is unreadable.'); }
  if (hash(JSON.stringify(manifest)) !== bank.id || !Array.isArray(paperIds)) fail('The selected question-paper bank manifest changed. Revalidate it before matching.');
  return { id: bank.id, source_root: manifest.source_root, source_file_count: manifest.files.length,
    canonical_pdf_count: paperIds.length, manifest, paper_ids: paperIds };
}

export function matchingBankPapers(schoolId,testId) {
  const bank = matchingBankInfo(schoolId,testId);
  if (!bank) return allPapers(); // Existing unrelated tests retain their library scope.
  const hashes = [...new Set(bank.manifest.files.map(file => file.pdf_sha256))];
  if (hashes.length !== bank.paper_ids.length || new Set(bank.paper_ids).size !== hashes.length) fail('The selected bank mapping is incomplete. No library fallback is allowed.');
  return bank.paper_ids.map((id,index) => {
    const paper = db.prepare('SELECT * FROM papers WHERE id=?').get(id);
    if (!paper) fail(`Selected question paper ${id} is missing. No library fallback is allowed.`);
    let bytes;
    try { bytes = fs.readFileSync(path.join(UPLOADS_DIR,paper.stored_name)); } catch { fail(`Selected question paper ${id} has no readable PDF.`); }
    if (hash(bytes) !== hashes[index]) fail(`Selected question paper ${id} changed. Revalidate the confirmed bank before matching.`);
    return { ...paper, matching_bank_sha256: bank.id };
  });
}

// Validate the entire pack before writing anything. A failed import rolls back
// DB inserts/selection and removes only files newly created by this attempt.
export async function importMatchingBank(buffer,{ schoolId,testId,expectedBankId=null }={}) {
  if (!db.prepare('SELECT id FROM tests WHERE id=? AND school_id=?').get(testId,schoolId)) fail('Choose a valid school and test for this bank.');
  if (db.prepare("SELECT id FROM bulk_items WHERE school_id=? AND test_id=? AND sort_status IN ('waiting','running') LIMIT 1").get(schoolId,testId)) fail('Wait for the matching queue to stop before changing its bank.');
  const current = matchingBankInfo(schoolId,testId);
  if ((current?.id ?? null) !== expectedBankId) fail('The selected bank changed. Review it before importing another bank.');
  let zip, raw;
  try {
    zip = await JSZip.loadAsync(buffer);
    const entry=zip.file('manifest.json');
    if (!entry || !Number.isSafeInteger(entry._data?.uncompressedSize) || entry._data.uncompressedSize > 2*1024*1024) fail('The manifest is missing or exceeds the unpacked size limit.');
    const bytes=await entry.async('nodebuffer');
    if(bytes.length > 2*1024*1024) fail('The manifest exceeds the unpacked size limit.');
    raw=JSON.parse(bytes.toString('utf8'));
  }
  catch { fail('The confirmed-bank ZIP requires a readable manifest.json.'); }
  if (raw?.schema_version !== 1 || !/^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/.test(raw.source_root ?? '') || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 1000 || raw.source_file_count !== raw.files.length) fail('The source-bank manifest has an invalid folder or incomplete source inventory.');
  const ids = new Set(), pdfs = new Map(), files=[];
  let expandedBytes = 0;
  for (const file of raw.files) {
    if (!file || typeof file.source_id !== 'string' || !file.source_id || ids.has(file.source_id) || !sha(file.source_sha256) || !sha(file.pdf_sha256) || !Number.isSafeInteger(file.source_size_bytes) || file.source_size_bytes < 1 || !Number.isSafeInteger(file.page_count) || file.page_count < 1 || file.validation_status !== 'validated' || typeof file.conversion_method !== 'string' || !file.conversion_method.trim() || typeof file.source_name !== 'string' || !file.source_name.trim()) fail('Every source needs unique identity, verified hashes, size, page count and validated conversion provenance.');
    ids.add(file.source_id);
    let sourceLink;
    try { sourceLink=new URL(file.source_url); } catch { fail('Every source needs its original Drive or Docs link.'); }
    if (sourceLink.protocol!=='https:' || sourceLink.port || sourceLink.username || sourceLink.password ||
      !((sourceLink.hostname==='drive.google.com' && sourceLink.pathname.split('/').slice(0,4).join('/')===`/file/d/${file.source_id}`) ||
        (sourceLink.hostname==='docs.google.com' && sourceLink.pathname.split('/').slice(0,4).join('/')===`/document/d/${file.source_id}`))) fail('Every source needs its matching original Drive or Docs link.');
    if (!/\.(pdf|docx)$/i.test(file.source_name)) fail('Only verified PDF or DOCX sources are supported.');
    if (/\.pdf$/i.test(file.source_name) && file.source_sha256 !== file.pdf_sha256) fail('Original PDFs must be retained byte-for-byte.');
    if (typeof file.pdf_path !== 'string' || file.pdf_path.startsWith('/') || file.pdf_path.split(/[\\/]/).some(part=>part==='..') || !/\.pdf$/i.test(file.pdf_path)) fail('Every PDF needs a safe relative path in the pack.');
    const entry=zip.file(file.pdf_path); if (!entry) fail(`Missing canonical PDF for ${file.source_name}.`);
    if (!Number.isSafeInteger(entry._data?.uncompressedSize) || entry._data.uncompressedSize > 30*1024*1024) fail('A canonical PDF exceeds the allowed unpacked size.');
    if (!pdfs.has(file.pdf_sha256)) expandedBytes += entry._data.uncompressedSize;
    if (expandedBytes > 200*1024*1024) fail('The canonical bank exceeds the allowed unpacked size.');
    const bytes=await entry.async('nodebuffer');
    if (bytes.length > 30*1024*1024 || !isPdf(bytes) || hash(bytes)!==file.pdf_sha256 || (/\.pdf$/i.test(file.source_name) && file.source_size_bytes!==bytes.length)) fail(`Invalid or changed canonical PDF for ${file.source_name}.`);
    if (!pdfs.has(file.pdf_sha256)) pdfs.set(file.pdf_sha256,{ bytes,source:file });
    files.push({source_id:file.source_id,source_url:file.source_url,source_name:file.source_name,
      source_sha256:file.source_sha256,source_size_bytes:file.source_size_bytes,pdf_path:file.pdf_path,
      pdf_sha256:file.pdf_sha256,page_count:file.page_count,conversion_method:file.conversion_method,
      validation_status:'validated',notes:String(file.notes??'')});
  }
  const manifest={schema_version:1,source_root:raw.source_root,source_file_count:files.length,files};
  const id=hash(JSON.stringify(manifest)), created=[];
  try {
    return db.transaction(()=>{
      // ZIP parsing yields to other requests; repeat both admission guards
      // inside the synchronous activation transaction.
      if ((matchingBankInfo(schoolId,testId)?.id ?? null) !== expectedBankId) fail('The selected bank changed while the pack was being validated. Review it before retrying.');
      if (db.prepare("SELECT id FROM bulk_items WHERE school_id=? AND test_id=? AND sort_status IN ('waiting','running') LIMIT 1").get(schoolId,testId)) fail('Matching started while the pack was being validated. Wait for the queue to stop.');
      const paperIds=[]; let added=0;
      for (const [checksum,{bytes,source}] of pdfs) {
        const existing=db.prepare('SELECT * FROM papers WHERE checksum=?').get(checksum);
        if (existing) {
          let actual; try {actual=fs.readFileSync(path.join(UPLOADS_DIR,existing.stored_name));} catch {fail('An existing master with this checksum is missing; restore it before importing.');}
          if(hash(actual)!==checksum) fail('An existing master checksum does not match its file; no overwrite was made.');
        }
        const result=addPaper(paperLabelsFrom({title:source.source_name,sections:'',notes:`Confirmed matching source: ${source.source_url}`}),{pdf:bytes,originalName:path.basename(source.pdf_path),onStored:filename=>created.push(filename)});
        if(result.added) added++;
        paperIds.push(result.paper.id);
      }
      db.prepare('INSERT OR IGNORE INTO matching_banks(id,manifest_json,paper_ids_json) VALUES(?,?,?)').run(id,JSON.stringify(manifest),JSON.stringify(paperIds));
      const prior=db.prepare('SELECT paper_ids_json FROM matching_banks WHERE id=?').get(id);
      if(prior.paper_ids_json!==JSON.stringify(paperIds)) fail('The immutable bank has a different existing master mapping.');
      db.prepare('INSERT INTO matching_bank_selections(school_id,test_id,bank_id) VALUES(?,?,?) ON CONFLICT(school_id,test_id) DO UPDATE SET bank_id=excluded.bank_id').run(schoolId,testId,id);
      matchingBankPapers(schoolId,testId);
      return {id,source_root:manifest.source_root,source_file_count:files.length,canonical_pdf_count:paperIds.length,paper_ids:paperIds,added,already:paperIds.length-added};
    })();
  } catch(error) { for(const filename of created) {try{fs.unlinkSync(path.join(UPLOADS_DIR,filename));}catch{}} throw error; }
}
