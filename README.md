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

## Running it on Fly.io

The app is deployed to Fly as `teachertrainingassessments`, and `fly.toml` and
`Dockerfile` in this repository are what the deploy builds from. Three settings
have to agree with each other, and the app breaks in a confusing way if they
drift apart:

- **`PORT` in `[env]` and `internal_port` in `[http_service]` must be the same
  number.** The app listens on `PORT`. If they disagree, Fly forwards traffic
  to a port with nothing on it and every request returns 502, which looks like
  the app is broken rather than misrouted.
- **`DATA_DIR` in `[env]` must be the `destination` of the `[[mounts]]`
  block.** That is where the SQLite database and the uploaded scans are
  written. If `DATA_DIR` is unset or points anywhere else, the data goes on the
  machine's own disk and is wiped on the next deploy, while the volume sits
  empty.
- **The app must run on one machine**, because the volume belongs to one
  machine. Two would quietly keep two separate databases. `fly scale count 1`.

Set the password as a secret, not in `fly.toml` — without it the URL is open to
anyone who finds it:

```
fly secrets set "APP_PASSWORD=a long password you choose"
```

Changing it later signs everyone out. `GET /healthz` answers `{"ok":true}` and
is what the health check in `fly.toml` uses, so a deploy that cannot serve
traffic rolls back instead of going live broken.

To take a copy of the database off the volume:

```
fly ssh sftp get /data/app.db
```

## Where your data lives

Everything is inside the `data/` folder next to the code:

- `data/app.db` — the SQLite database with schools, teachers and assessments.
- `data/uploads/` — the school logos and the scanned pages.

That folder is **not** committed to git, so nothing about a real school or
teacher ends up on GitHub. To back your work up, copy the whole `data/` folder.
To start over, delete it and restart the app.

On Fly the same two live on the volume at `/data`, never in the repository.

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
Dockerfile          builds the image that Fly runs
fly.toml            the Fly machine, volume, ports and health check
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
