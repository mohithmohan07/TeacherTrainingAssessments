import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Synthetic blank documents with valid cross references; no school materials.
function pdfBytes(count) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: count }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>')];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

test('PDF source page counts stay exact with production dependencies', async () => {
  for (const count of [1, 3]) {
    const loading = getDocument({ data: pdfBytes(count), isEvalSupported: false });
    try { assert.equal((await loading.promise).numPages, count); }
    finally { await loading.destroy(); }
  }
});

test('malformed PDFs cannot supply a guessed page count', async () => {
  const loading = getDocument({ data: new Uint8Array(Buffer.from('not a valid PDF')), isEvalSupported: false });
  try { await assert.rejects(loading.promise, { name: 'InvalidPDFException' }); }
  finally { await loading.destroy(); }
});
