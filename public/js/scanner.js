// Scanning straight from the scanner on this laptop.
//
// A web page cannot reach a scanner by itself, so the Scan buttons talk to a
// small helper that runs on the laptop the scanner is plugged into (the
// scanner-helper folder in the repository, also downloadable from the app).
// The helper listens on this computer only, at the address below. It scans,
// keeps the pages, and hands them back here; the page then uploads them
// exactly as if they had been chosen as image files.

const HELPER = 'http://127.0.0.1:17645';
const PREFERENCE_KEY = 'tta.scanner';
const QUICK_CHECK_MS = 4000;

export const HELPER_DOWNLOAD_URL = '/downloads/scanner-helper.zip';

// status is one of:
//   off         scanning not turned on in this browser; buttons pick files
//   checking    looking for the helper
//   ready       helper found with at least one scanner; buttons scan
//   missing     helper not running (or not reachable) on this computer
//   blocked     the browser refuses to let this page reach the helper
//   no-scanner  helper is running but sees no scanner
export const scanner = {
  status: 'off',
  checked: false,
  scanners: [],
  selectedId: '',
  folder: '',
  message: '',
  busy: false,
};

function readPreference() {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null') ?? {};
  } catch {
    return {};
  }
}

function writePreference(changes) {
  try {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ ...readPreference(), ...changes }));
  } catch {
    // Private windows can refuse storage; scanning still works for this visit.
  }
}

export function scanningWanted() {
  return readPreference().on === true;
}

export function scanBothSides() {
  return readPreference().bothSides !== false;
}

export function setScanBothSides(value) {
  writePreference({ bothSides: Boolean(value) });
}

export function selectScanner(id) {
  scanner.selectedId = id;
  writePreference({ scannerId: id });
}

export function selectedScanner() {
  return scanner.scanners.find((item) => item.id === scanner.selectedId) ?? scanner.scanners[0] ?? null;
}

// Chrome and Edge ask once before a website may reach apps on this computer.
// If that was answered with Block, say so rather than "not running".
async function browserBlocksHelper() {
  if (!navigator.permissions?.query) return false;
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try {
      const permission = await navigator.permissions.query({ name });
      if (permission.state === 'denied') return true;
    } catch {
      // Not a permission this browser knows about.
    }
  }
  return false;
}

async function helperUnreachable() {
  scanner.status = (await browserBlocksHelper()) ? 'blocked' : 'missing';
  scanner.scanners = [];
}

// Asks the helper which scanners it can see. A quick check (on page load) gives
// up after a few seconds; a patient one (the user pressed Connect) waits,
// because the browser may be showing its "allow access" question meanwhile.
export async function checkScanner({ patient = false } = {}) {
  scanner.status = 'checking';
  scanner.message = '';
  try {
    const response = await fetch(`${HELPER}/status`, {
      cache: 'no-store',
      signal: patient ? undefined : AbortSignal.timeout(QUICK_CHECK_MS),
    });
    const body = await response.json();
    scanner.scanners = Array.isArray(body.scanners) ? body.scanners : [];
    scanner.folder = body.folder ?? '';
    scanner.message = body.error ?? '';
    if (!response.ok || !scanner.scanners.length) {
      scanner.status = 'no-scanner';
    } else {
      const remembered = readPreference().scannerId;
      scanner.selectedId = scanner.scanners.some((item) => item.id === remembered) ? remembered : scanner.scanners[0].id;
      scanner.status = 'ready';
    }
  } catch {
    await helperUnreachable();
  }
  scanner.checked = true;
  return scanner.status;
}

export async function connectScanner() {
  writePreference({ on: true });
  return checkScanner({ patient: true });
}

export function stopScanning() {
  writePreference({ on: false });
  scanner.status = 'off';
  scanner.scanners = [];
}

// On first visit to a page this session, look for the helper if scanning was
// turned on before. Resolves true when the status changed and needs drawing.
export async function checkScannerOnce() {
  if (scanner.checked || !scanningWanted()) return false;
  await checkScanner();
  return true;
}

export class ScanError extends Error {
  constructor(message, { helperGone = false } = {}) {
    super(message);
    this.helperGone = helperGone;
  }
}

// Scans whatever is in the scanner and returns the pages as File objects,
// ready to append to a FormData, plus any warning (such as a jam part way
// through, after which the pages before it are still returned). `label`
// names the files the helper keeps.
export async function scanPages({ label }) {
  if (scanner.busy) throw new ScanError('A scan is already running. Wait for it to finish.');
  scanner.busy = true;
  try {
    let response;
    try {
      response = await fetch(`${HELPER}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanner: selectedScanner()?.id ?? '', bothSides: scanBothSides(), label }),
      });
    } catch {
      await helperUnreachable();
      throw new ScanError(
        scanner.status === 'blocked'
          ? 'Your browser is blocking this page from reaching the scanner helper.'
          : 'The scanner helper is not running on this laptop. Start it, then press Scan again.',
        { helperGone: true }
      );
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ScanError(body.error ?? `The scanner helper answered ${response.status}.`);
    if (body.folder) scanner.folder = body.folder;

    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!pages.length) throw new ScanError('The scanner did not return any pages.');

    const files = [];
    for (const page of pages) {
      const pageResponse = await fetch(`${HELPER}/pages/${encodeURIComponent(page.id)}`, { cache: 'no-store' });
      if (!pageResponse.ok) throw new ScanError(`Could not collect ${page.name} from the scanner helper.`);
      const blob = await pageResponse.blob();
      files.push(new File([blob], page.name, { type: page.type || blob.type || 'image/jpeg' }));
    }
    return { files, warning: body.warning ?? '' };
  } finally {
    scanner.busy = false;
  }
}
