// Every report of a test in one zip, for "Download all reports" on the
// Assessments page. The zip holds a folder named after the test, such as
// "Test 1 results", with each teacher's own report in "Reports for Teachers",
// each management report on a teacher in "Reports for Management", and the
// school report as "Overall School Report.pdf".
//
// The reports are printed to PDF by Chromium on the server, from the same
// pages the app shows, so each one matches what Print gives. That takes a few
// seconds a report, so the zip is made in the background, one test at a time,
// and the page checks back on it; it is kept for an hour after.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from './db.js';
import { serverSession } from './auth.js';
import { LAYOUT, findReport, isOutOfDate, schoolOverview, schoolReportIsOutOfDate } from './reports.js';
import { teacherResults } from './results.js';
import { friendly } from './openai.js';
import { getFramework } from './training.js';
import { ZipFile } from './zip.js';

const PORT = Number(process.env.PORT ?? 3000);
const ZIP_DIR = path.join(os.tmpdir(), 'teacher-report-zips');
const KEEP_MS = 60 * 60 * 1000;
// The longest a report may take to open and print. Long answer papers take
// the most, as every page is made smaller before printing.
const PAGE_TIMEOUT_MS = 3 * 60 * 1000;

const TEACHER_FOLDER = 'Reports for Teachers';
const MANAGEMENT_FOLDER = 'Reports for Management';
const SCHOOL_FILE = 'Overall School Report.pdf';

// Zips from before a restart are gone with the jobs that made them.
fs.rmSync(ZIP_DIR, { recursive: true, force: true });

const selectSchool = db.prepare('SELECT id, name FROM schools WHERE id = ?');
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');
const selectTeachers = db.prepare('SELECT id, name FROM teachers WHERE school_id = ? ORDER BY name COLLATE NOCASE');

// Chromium, wherever it is: CHROMIUM_PATH if set, else Chromium's headless
// shell as the Docker image installs it (it needs about a third less memory
// than the full browser), else the full browser, else Chrome or Edge where
// the app runs on a laptop.
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium-headless-shell',
  '/usr/lib/chromium/chromium-headless-shell',
  '/usr/lib/chromium/headless_shell',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// A name Windows accepts for a file or folder.
function fileName(name) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!clean) return 'Unnamed';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? `${clean}_` : clean;
}

// File names in one folder, numbered when two teachers share a name.
function namer() {
  const used = new Set();
  return (name) => {
    const base = fileName(name);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base} (${n})`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

// What goes in the zip: every teacher with a written report, and the school
// report if it is written. Reports out of date still go in, and are listed.
// Reports in an earlier layout stay out, as the app no longer shows them.
function planFor(school, test) {
  const framework = getFramework();
  const plan = { teachers: [], left_out: [], old_layout: [], out_of_date: [], writing: 0, school: 'missing' };
  for (const teacher of selectTeachers.all(school.id)) {
    const sections = teacherResults(teacher.id, test.id);
    if (!sections.length) continue;
    const report = findReport('teacher', test.id, teacher.id);
    if (report?.status === 'running') {
      plan.writing += 1;
    } else if (report?.content?.layout === LAYOUT) {
      plan.teachers.push(teacher);
      if (report.status === 'failed' || isOutOfDate(report, sections, framework)) plan.out_of_date.push(teacher.name);
    } else if (report?.content) {
      plan.old_layout.push(teacher.name);
    } else {
      plan.left_out.push(teacher.name);
    }
  }
  const report = findReport('school', test.id, null);
  if (report?.status === 'running') plan.writing += 1;
  else if (report?.content?.layout === LAYOUT) {
    plan.school = report.status === 'failed' || schoolReportIsOutOfDate(report, schoolOverview(school.id, test.id)) ? 'out_of_date' : 'included';
  } else if (report?.content) {
    plan.school = 'old_layout';
  }
  return plan;
}

const printsSchool = (plan) => plan.school === 'included' || plan.school === 'out_of_date';

/* ----------------------------------------------------------------- jobs */

// The zips being made or ready, by school and test, and whether Chromium is
// busy: it is the heaviest thing the server runs, so one zip is made at a time.
const jobs = new Map();
let busy = false;

const keyOf = (schoolId, testId) => `${schoolId}:${testId}`;

function forget(job) {
  if (jobs.get(keyOf(job.school_id, job.test_id)) === job) jobs.delete(keyOf(job.school_id, job.test_id));
  if (job.file) fs.rm(job.file, { force: true }, () => {});
}

// What the page is told about a job.
export function zipState(schoolId, testId) {
  const job = jobs.get(keyOf(schoolId, testId));
  if (!job) return null;
  return {
    status: job.status,
    done: job.done,
    total: job.total,
    current: job.current,
    name: job.name,
    size: job.size,
    left_out: job.left_out,
    old_layout: job.old_layout,
    out_of_date: job.out_of_date,
    school: job.school,
    not_printed: job.not_printed,
    out_of_memory: job.out_of_memory,
    error: job.error,
    finished_at: job.finished_at,
  };
}

// The finished zip's file and download name, or null.
export function zipFile(schoolId, testId) {
  const job = jobs.get(keyOf(schoolId, testId));
  return job?.status === 'done' ? { file: job.file, name: job.name } : null;
}

// A time zone and language for the printed dates, from the browser that asked,
// so the PDFs give dates as the app does on its screen.
function viewerSettings({ time_zone: timeZone, locale } = {}) {
  const settings = {};
  try {
    if (timeZone) settings.timeZone = new Intl.DateTimeFormat('en', { timeZone: String(timeZone) }).resolvedOptions().timeZone;
  } catch {
    // An unknown time zone: the server's is used.
  }
  try {
    if (locale) settings.locale = Intl.getCanonicalLocales(String(locale))[0];
  } catch {
    // An unknown language: the browser's own is used.
  }
  return settings;
}

// Starts making the zip for a test. Returns why it cannot, or null.
export function startZip(schoolId, testId, viewer) {
  const school = selectSchool.get(schoolId);
  const test = selectTest.get(testId);
  if (!school || !test || test.school_id !== school.id) return 'School or test not found.';
  if (busy) return 'A zip of reports is already being made. Try again when it is ready.';
  if (!chromiumPath()) return 'Chromium is not installed on the server, so the reports cannot be printed to PDF. Set CHROMIUM_PATH to Chrome or Chromium.';

  const plan = planFor(school, test);
  if (plan.writing) {
    return `${plan.writing === 1 ? 'A report is' : `${plan.writing} reports are`} still being written. Download all reports once ${plan.writing === 1 ? 'it is' : 'they are'} done.`;
  }
  if (!plan.teachers.length && !printsSchool(plan)) {
    return plan.old_layout.length || plan.school === 'old_layout'
      ? 'The reports for this test were written in the earlier layout. Rebuild them first, then download them.'
      : 'No reports have been written for this test yet. Build them first.';
  }

  const previous = jobs.get(keyOf(school.id, test.id));
  if (previous) forget(previous);
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const folder = `${fileName(test.name)} results`;
  const job = {
    school_id: school.id,
    test_id: test.id,
    status: 'running',
    done: 0,
    total: plan.teachers.length * 2 + (printsSchool(plan) ? 1 : 0),
    current: null,
    folder,
    name: `${folder}.zip`,
    file: path.join(ZIP_DIR, `${crypto.randomBytes(8).toString('hex')}.zip`),
    size: null,
    left_out: plan.left_out,
    old_layout: plan.old_layout,
    out_of_date: plan.out_of_date,
    school: plan.school,
    not_printed: [],
    out_of_memory: false,
    error: null,
    finished_at: null,
    ...viewerSettings(viewer),
  };
  jobs.set(keyOf(school.id, test.id), job);
  busy = true;
  makeZip(job, plan, school)
    .then(() => {
      job.status = 'done';
    })
    .catch((error) => {
      console.error(`Making the report zip for test ${test.id} failed:`, error);
      job.status = 'failed';
      job.error = error.userMessage ?? 'The reports could not be printed. Try again in a minute.';
      fs.rm(job.file, { force: true }, () => {});
    })
    .finally(() => {
      busy = false;
      job.current = null;
      job.finished_at = new Date().toISOString();
      setTimeout(() => forget(job), KEEP_MS).unref();
    });
  return null;
}

/* ------------------------------------------------------------- printing */

async function launchChromium() {
  // Loaded only when a zip is made, so the server starts as light as before.
  const { default: puppeteer } = await import('puppeteer-core');
  const executablePath = chromiumPath();
  console.log(`Printing reports with ${executablePath}`);
  return puppeteer.launch({
    executablePath,
    // The headless shell is a build of its own; the full browser runs headless.
    headless: /headless/i.test(path.basename(executablePath)) ? 'shell' : true,
    // The server's container runs as root, where Chromium's sandbox cannot
    // start; it only ever opens this app's own pages.
    args: ['--no-sandbox', '--disable-gpu'],
  });
}

async function newPage(browser, job) {
  // A fresh session for each page, however long the zip takes.
  const session = serverSession();
  if (session) await browser.setCookie({ ...session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  if (job.timeZone) await page.emulateTimezone(job.timeZone);
  if (job.locale) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setLocaleOverride', { locale: job.locale }).catch(() => {});
  }
  return page;
}

// Each step on a page, given up when the page crashes or its report runs out
// of time: a crashed page answers nothing, so a step on it would otherwise
// wait for ever. Chromium stops a page that needs more memory than the server
// has, as a page of very large photographs can.
function guard(page) {
  let crashed = false;
  let crash;
  const stopped = new Promise((_resolve, reject) => {
    crash = reject;
  });
  stopped.catch(() => {});
  page.once('error', (error) => {
    crashed = true;
    crash(error);
  });
  return {
    crashed: () => crashed,
    async run(step, deadline) {
      step.catch(() => {});
      let timer;
      const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The report took too long to print.')), Math.max(0, deadline - Date.now()));
      });
      try {
        return await Promise.race([step, stopped, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a report page to finish drawing, with its evidence pages, its
// pictures and its fonts, then prints it as Print would, without the app's
// links (they lead nowhere outside the app). While it waits it has Chromium
// collect garbage every half second: Chromium holds each scan the page has
// made smaller until then, which for a long answer paper is more memory than
// the server has to spare.
async function printReport(page, steps, { audience, title }) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  const cdp = await steps.run(page.createCDPSession(), deadline);
  try {
    for (;;) {
      const state = await steps.run(
        page.evaluate((audience) => {
          const failed = document.querySelector('#view > .empty');
          if (failed) return { error: failed.textContent };
          const sheet = document.querySelector('.report-sheet');
          if (!sheet || sheet.querySelector('.report-audience')?.textContent !== audience) return {};
          if (sheet.querySelector('.report-evidence[data-evidence="loading"]')) return {};
          return { ready: [...document.images].every((img) => img.complete) };
        }, audience),
        deadline
      );
      if (state.error) throw new Error(state.error);
      await steps.run(cdp.send('HeapProfiler.collectGarbage'), deadline);
      if (state.ready) break;
      await steps.run(pause(500), deadline);
    }
  } finally {
    cdp.detach().catch(() => {});
  }
  await steps.run(
    page.evaluate(async (title) => {
      document.title = title;
      for (const link of document.querySelectorAll('.report-sheet a[href]')) link.removeAttribute('href');
      await document.fonts.ready;
    }, title),
    deadline
  );
  const pdf = await steps.run(page.pdf({ format: 'A4', preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, timeout: 0 }), deadline);
  return Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}

// Chromium gone mid-way: nothing more can be printed.
const CHROMIUM_STOPPED = 'Chromium stopped while printing the reports, most likely for lack of memory. Try again, and if it happens again, give the app 1 GB of memory.';

async function makeZip(job, plan, school) {
  const base = `http://127.0.0.1:${PORT}/#`;
  const teacherNames = namer();
  const managementNames = namer();
  const browser = await launchChromium().catch((error) => {
    console.error('Chromium did not start:', error);
    throw friendly('Chromium did not start on the server, so the reports cannot be printed.');
  });
  const zip = await ZipFile.create(job.file);
  let printed = 0;
  try {
    for (const [index, teacher] of plan.teachers.entries()) {
      job.current = teacher.name;
      const page = await newPage(browser, job);
      const steps = guard(page);
      let ownPrinted = false;
      try {
        await page.goto(`${base}/teachers/${teacher.id}/report/${job.test_id}`);
        const own = await printReport(page, steps, { audience: 'For the Teacher', title: `${teacher.name}: Teacher Report` });
        await zip.add(`${job.folder}/${TEACHER_FOLDER}/${teacherNames(teacher.name)}.pdf`, own);
        job.done += 1;
        printed += 1;
        ownPrinted = true;
        // The management report is the same page's other half, and its
        // evidence pages are already made.
        await steps.run(
          page.evaluate((hash) => {
            window.location.hash = hash;
          }, `#/teachers/${teacher.id}/report/${job.test_id}?for=management`),
          Date.now() + PAGE_TIMEOUT_MS
        );
        const management = await printReport(page, steps, { audience: 'For Management', title: `${teacher.name}: Management Report` });
        await zip.add(`${job.folder}/${MANAGEMENT_FOLDER}/${managementNames(teacher.name)}.pdf`, management);
        printed += 1;
      } catch (error) {
        if (!browser.connected) throw friendly(CHROMIUM_STOPPED);
        console.error(`Printing ${teacher.name}'s reports failed:`, error);
        job.not_printed.push(ownPrinted ? `${teacher.name} (management report)` : teacher.name);
        if (steps.crashed()) job.out_of_memory = true;
      } finally {
        job.done = 2 * (index + 1);
        await page.close().catch(() => {});
      }
    }

    if (printsSchool(plan)) {
      job.current = 'the school report';
      const page = await newPage(browser, job);
      const steps = guard(page);
      try {
        await page.goto(`${base}/schools/${school.id}/report/${job.test_id}`);
        await zip.add(`${job.folder}/${SCHOOL_FILE}`, await printReport(page, steps, { audience: 'For Management', title: `${school.name}: School Report` }));
        printed += 1;
      } catch (error) {
        if (!browser.connected) throw friendly(CHROMIUM_STOPPED);
        console.error('Printing the school report failed:', error);
        job.not_printed.push('the school report');
        if (steps.crashed()) job.out_of_memory = true;
      } finally {
        job.done = job.total;
        await page.close().catch(() => {});
      }
    }

    if (!printed) throw friendly('None of the reports could be printed. Try again in a minute.');
    job.size = await zip.close();
  } catch (error) {
    await zip.abandon();
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}
