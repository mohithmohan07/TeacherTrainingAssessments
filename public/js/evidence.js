// The pages at the end of a teacher's reports: the question paper and the
// answer paper the marks came from. Scans are made smaller, and the library's
// question papers, which are PDFs, are drawn page by page with PDF.js. Every
// page becomes a JPEG about 150 dots per inch across an A4 page, which is
// plenty to read handwriting and keeps a printed report a manageable size.

const WIDTH = 1240;
const QUALITY = 0.72;
const PDFJS = '/vendor/pdfjs';

// Pages already made, by the file's address, so switching between the
// teacher's and management's report does not make them again.
const made = new Map();

// One file at a time, so a long answer paper never has every page decoded at
// full size at once.
let line = Promise.resolve();
function inTurn(work) {
  const run = line.then(work);
  line = run.catch(() => {});
  return run;
}

let pdfjs = null;
export function loadPdfjs() {
  pdfjs ??= import(`${PDFJS}/build/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjs;
}

function jpegOf(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Lets go of the canvas's pixels now rather than whenever it is collected.
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(URL.createObjectURL(blob));
        else reject(new Error('The page could not be made into a picture.'));
      },
      'image/jpeg',
      QUALITY
    );
  });
}

async function shrinkScan(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The scan is no longer on the server.');
  const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    // A JPEG has no transparency: see-through parts of a PNG print white.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return [await jpegOf(canvas)];
  } finally {
    bitmap.close();
  }
}

async function drawPdf(url) {
  const lib = await loadPdfjs();
  const loading = lib.getDocument({
    url,
    cMapUrl: `${PDFJS}/cmaps/`,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
    iccUrl: `${PDFJS}/iccs/`,
  });
  try {
    const doc = await loading.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: WIDTH / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, intent: 'print', background: '#fff' }).promise;
      pages.push(await jpegOf(canvas));
      page.cleanup();
    }
    return pages;
  } finally {
    // Stops PDF.js's worker, which holds the whole document.
    await loading.destroy();
  }
}

// A file's pages as pictures ready to show and print: one for a scan, one for
// each page of a PDF. `file` is { url, pdf }.
export function pagesOf(file) {
  if (!made.has(file.url)) {
    const pages = inTurn(() => (file.pdf ? drawPdf(file.url) : shrinkScan(file.url)));
    made.set(file.url, pages);
    // A file that failed is tried again the next time it is shown.
    pages.catch(() => made.delete(file.url));
  }
  return made.get(file.url);
}

// Lets go of the pages of files no longer shown, so moving from one teacher's
// reports to the next does not keep every teacher's pages.
export function keepOnly(urls) {
  const keep = new Set(urls);
  for (const [url, pages] of made) {
    if (keep.has(url)) continue;
    made.delete(url);
    pages.then((list) => list.forEach((page) => URL.revokeObjectURL(page)), () => {});
  }
}
