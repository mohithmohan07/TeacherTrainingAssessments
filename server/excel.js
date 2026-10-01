import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export const TEMPLATE_COLUMNS = [
  { header: 'Teacher Name', key: 'name', width: 30 },
  { header: 'Grade', key: 'grade', width: 16 },
  { header: 'Subjects', key: 'subjects', width: 40 },
  { header: 'Email (optional)', key: 'email', width: 28 },
  { header: 'Phone (optional)', key: 'phone', width: 20 },
];

// Examples live on the instructions sheet, never on the sheet that gets imported,
// so a forgotten sample row can never become a real teacher.
const EXAMPLE_ROWS = [
  ['Asha Menon', 'Grade 5', 'Mathematics, Science'],
  ['Rahul Verma', 'Grade 8', 'English'],
  ['Priya Nair', 'Grade 10', 'Physics, Chemistry'],
];

// Header text -> field name. Matching is case-insensitive and ignores anything
// in brackets, so "Subjects (comma separated)" still maps to `subjects`.
const HEADER_ALIASES = {
  'teacher name': 'name',
  name: 'name',
  teacher: 'name',
  grade: 'grade',
  class: 'grade',
  'grade/class': 'grade',
  subjects: 'subjects',
  subject: 'subjects',
  email: 'email',
  'email address': 'email',
  phone: 'phone',
  'phone number': 'phone',
  mobile: 'mobile',
};

function normaliseHeader(value) {
  return String(value ?? '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink !== undefined) return String(value.hyperlink);
    return '';
  }
  return String(value);
}

export async function buildTeacherTemplate(school) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Teacher Training Assessments';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Teachers', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = TEMPLATE_COLUMNS;

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  const notes = workbook.addWorksheet('How to use');
  notes.columns = [{ width: 26 }, { width: 22 }, { width: 46 }];

  const lines = [
    school ? `Teacher import template for: ${school.name}` : 'Teacher import template',
    '',
    'Fill in one teacher per row on the "Teachers" sheet, then save the file as .xlsx',
    'and upload it on the school page. Keep the heading row as it is.',
    '',
    'Teacher Name   required',
    'Grade          the grade or class they teach, e.g. "Grade 5" or "Grades 6-8"',
    'Subjects       one or more subjects separated by commas, e.g. "Mathematics, Science"',
    'Email, Phone   optional',
    '',
    'Rows with no teacher name are skipped, and so is anyone already on the school\'s list.',
    '',
    'Examples (these are here for reference only - they are not imported):',
  ];
  for (const line of lines) notes.addRow([line]);
  notes.getRow(1).font = { bold: true, size: 14 };

  const exampleHeader = notes.addRow(['Teacher Name', 'Grade', 'Subjects']);
  exampleHeader.font = { bold: true };
  for (const row of EXAMPLE_ROWS) {
    notes.addRow(row).font = { color: { argb: 'FF8A8A8A' } };
  }

  return workbook.xlsx.writeBuffer();
}

/**
 * ExcelJS only understands workbooks laid out the way Excel itself saves them.
 * Files written by other tools (Open XML SDK, some online converters and AI
 * assistants) are equally valid but use prefixed tags such as <x:sheet> and
 * absolute part paths such as "/xl/workbook.xml", and ExcelJS then fails with
 * "Cannot read properties of undefined (reading 'sheets')". Rewriting those two
 * things gives ExcelJS the same workbook in the form it expects.
 */
const DEFAULT_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://schemas.openxmlformats.org/package/2006/content-types',
]);

async function normaliseWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.(xml|rels)$/i.test(file.name)) continue;
    const original = await file.async('string');
    let xml = original.replace(/^\uFEFF/, '');

    // Drop the prefix when the root element is in one of the namespaces Excel
    // writes unprefixed: <x:worksheet xmlns:x="..."> becomes <worksheet xmlns="...">.
    // Other parts (such as docProps/core.xml) keep their prefixes, which ExcelJS expects.
    const root = xml.match(/<(?![?!])([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*([^>]*)>/);
    const rootTagIsFirst = root && !/<(?![?!])/.test(xml.slice(0, root.index));
    const rootNamespace = root?.[2].match(new RegExp(`xmlns:${root[1]}="([^"]*)"`))?.[1];
    if (rootTagIsFirst && DEFAULT_NAMESPACES.has(rootNamespace) && !/\sxmlns=/.test(root[2])) {
      const prefix = root[1];
      xml = xml
        .replace(new RegExp(`(</?)${prefix}:`, 'g'), '$1')
        .replace(new RegExp(`xmlns:${prefix}=`, 'g'), 'xmlns=');
    }

    // Relationship targets: "/xl/worksheets/sheet1.xml" -> relative to the part.
    if (file.name.endsWith('.rels')) {
      const baseDir = file.name.replace(/(^|\/)_rels\/[^/]*$/, '$1');
      xml = xml.replace(/Target="\/([^"]*)"/g, (match, target) => {
        if (!baseDir) return `Target="${target}"`;
        return target.startsWith(baseDir) ? `Target="${target.slice(baseDir.length)}"` : match;
      });
    }

    if (xml !== original) zip.file(file.name, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
    if (workbook.worksheets.length) return workbook;
  } catch {
    // fall through and try the normalised copy
  }
  const retry = new ExcelJS.Workbook();
  try {
    await retry.xlsx.load(await normaliseWorkbook(buffer));
  } catch {
    throw new Error(
      'Could not read this file as an Excel workbook. Open it in Excel, choose Save As, pick "Excel Workbook (.xlsx)" and upload the saved copy.'
    );
  }
  return retry;
}

/**
 * Reads an uploaded workbook and returns { rows, errors }.
 * `rows` are cleaned teacher records; `errors` describe rows that were skipped.
 */
export async function parseTeacherWorkbook(buffer) {
  let workbook;
  try {
    workbook = await loadWorkbook(buffer);
  } catch (error) {
    return { rows: [], errors: [{ row: 0, message: error.message }] };
  }

  const sheet =
    workbook.getWorksheet('Teachers') ??
    workbook.worksheets.find((ws) => ws.rowCount > 0) ??
    null;

  if (!sheet) {
    return { rows: [], errors: [{ row: 0, message: 'The workbook has no sheets with any data.' }] };
  }

  const headerRow = sheet.getRow(1);
  const columnMap = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const field = HEADER_ALIASES[normaliseHeader(cellText(cell.value))];
    if (field && !(field in columnMap)) columnMap[field] = colNumber;
  });

  if (!columnMap.name) {
    return {
      rows: [],
      errors: [
        {
          row: 1,
          message:
            'Could not find a "Teacher Name" column in the first row. Please use the downloaded template.',
        },
      ],
    };
  }

  const rows = [];
  const errors = [];
  const seen = new Set();

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const read = (field) =>
      columnMap[field] ? cellText(row.getCell(columnMap[field]).value).trim() : '';

    const name = read('name');
    const grade = read('grade');
    const subjects = read('subjects')
      .split(/[,;/]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(', ');
    const email = read('email');
    const phone = read('phone') || read('mobile');

    if (!name && !grade && !subjects && !email && !phone) continue; // blank row

    if (!name) {
      errors.push({ row: rowNumber, message: 'Skipped: no teacher name in this row.' });
      continue;
    }

    const key = `${name.toLowerCase()}|${grade.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ row: rowNumber, message: `Skipped: "${name}" appears more than once in the file.` });
      continue;
    }
    seen.add(key);

    rows.push({ name, grade, subjects, email, phone });
  }

  return { rows, errors };
}
