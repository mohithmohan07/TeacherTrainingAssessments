# Teacher Training Assessments

A small web app for running teacher training assessments. It runs on your own
laptop: there is no cloud account, no login, and everything is stored in a file
on your machine.

- **Dashboard** — the screen it opens on. A few counts and the latest
  assessments for now; the real content is still to be decided.
- **Schools & teachers** — add each school with its logo and contact details,
  then add its teachers one at a time or import a whole list from Excel.
- **Assessments** — pick a school and a teacher, then upload the scanned
  question paper and the teacher's responses, and record the evaluation.

## Running it

You need [Node.js](https://nodejs.org) 20 or newer. Check with `node --version`.

```bash
npm install     # once, to fetch the dependencies
npm start
```

Then open **http://localhost:3000** in your browser.

To see the app with some invented sample data in it, run `npm run seed` before
`npm start`. It does nothing if you already have schools in the database.

To use a different port: `PORT=4000 npm start`. In PowerShell on Windows,
settings go on their own line instead:

```powershell
$env:PORT = "4000"
npm start
```

The app has no login when you run it locally. If you ever want one — because
you are running it somewhere other people can reach — set `APP_PASSWORD` and
it will ask for that password before showing anything.

## Importing teachers from Excel

1. Open a school, and click **Download Excel template**.
2. Fill in one teacher per row on the *Teachers* sheet: teacher name, grade and
   subjects. The name is the only required column. There is a *How to use*
   sheet with examples.
3. Save the file and upload it under **Bulk import teachers**.

The import tells you how many teachers it added, and lists any rows it skipped.
Rows with no name are skipped, and so is anyone already on that school's list,
so you can safely re-upload a file you have added a few rows to.

## Uploading scans

The browser cannot drive your scanner directly, so scan the pages with the
software already installed on your laptop, save them as images, and then drag
those files onto the assessment — or click to pick them. You can add several
pages at once, to the question paper and to the response separately, and click
any page to see it full size.

JPG, PNG, WEBP, TIFF, GIF and BMP are accepted, up to 25 MB per page.

## Hosting it somewhere other than your laptop

There is no deployment configuration in this repository — set the hosting up
whichever way suits you. Two things about this app matter wherever it runs:

- **The database and the scans are files on disk.** They live in the folder
  `DATA_DIR` points at, `data/` by default. Most hosts wipe a machine's own
  disk on every deploy, so point `DATA_DIR` at storage that survives one, and
  run a single instance: two instances with separate disks would quietly keep
  two separate databases.
- **Set `APP_PASSWORD` if the app is reachable from the internet.** With it
  set, every page, API call and scanned image needs you to sign in once, and
  the session lasts 30 days. Without it the app is wide open — fine on your own
  laptop, not fine on a public URL. Changing the password signs everyone out.

The app listens on `PORT` (3000 by default) and answers `GET /healthz` with
`{"ok":true}`, which is usually what a host wants for a health check.

## Where your data lives

Everything is inside the `data/` folder next to the code:

- `data/app.db` — the SQLite database with schools, teachers and assessments.
- `data/uploads/` — the school logos and the scanned pages.

That folder is **not** committed to git, so nothing about a real school or
teacher ends up on GitHub. To back your work up, copy the whole `data/` folder.
To start over, delete it and restart the app.

Wherever else you run it, the same two live under whatever `DATA_DIR` points
at, never in the repository.

Set `DATA_DIR` to keep it somewhere else, for example
`DATA_DIR=~/Documents/assessments npm start`.

## How it is built

Plain and deliberately boring, so it keeps working:

- **Node.js + Express** for the server (`server/`).
- **SQLite** through `better-sqlite3` — a single file, no database to install.
- **ExcelJS** for the .xlsx template and import.
- **Plain HTML, CSS and JavaScript** for the front end (`public/`) — no build
  step, so what is in the folder is what runs in the browser.

```
server/
  index.js          the Express app and the dashboard stats
  auth.js           the optional password gate (off unless APP_PASSWORD is set)
  db.js             database connection and schema
  excel.js          the import template, and reading a filled-in one back
  uploads.js        file upload rules (types and size limits)
  seed.js           optional sample data
  routes/           schools, teachers, assessments
public/
  index.html        the single page
  css/styles.css
  js/               router, API client, and one file per screen
```
