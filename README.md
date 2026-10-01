# Teacher Training Assessments

A small web app for running teacher training assessments. It runs on your own
laptop: there is no cloud account, no login, and everything is stored in a file
on your machine.

- **Dashboard** — the screen it opens on. For each school, in its newest test
  (or another picked on the card): who is waiting (nothing uploaded, scanned
  but not evaluated, marking failed, report not built), how many teachers sat
  each section and their grades in it, and the potential identifier counts,
  with names linking to teacher profiles. Grades only, per section.
- **Schools & teachers** — add each school with its logo and contact details,
  then add its teachers one at a time or import a whole list from Excel.
- **Assessments** — pick a school and a test, then scan or upload each
  teacher's question paper and response on their row and press Evaluate.
  Each section is graded on its own, and reports are written from the marks.
- **Teacher profiles** — click a teacher's name to see every test they have
  sat, section by section, and how each section has moved between tests.

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

Each teacher's row on the **Assessments** page has an Upload button for the
question paper and one for the response. They either scan straight from the
scanner or upload image files.

### Scanning straight from the scanner

A web page cannot reach a scanner by itself, so a small helper runs on the
laptop the scanner is plugged into and does it for the page. It is in the
`scanner-helper` folder, and the app offers it as a download (**Download the
scanner helper** on the Assessments page).

1. Extract the zip and double-click **Start scanner helper**. The first time,
   it fetches a private copy of the official 32-bit Python from nuget.org and
   checks its SHA-256 before using it; the scanner's TWAIN driver (PaperStream
   IP for the Fujitsu SP-1130N) is 32-bit, so the helper has to be too.
2. On the Assessments page, press **Connect scanner** once. Chrome and Edge
   may ask whether the site can reach apps on this device; choose Allow.
3. The row buttons now read **Scan**. Put the pages in the feeder and press
   Scan: every page in the feeder is scanned and filed against that teacher.
   **Both sides** scans both sides of each sheet and drops blank backs.

The helper listens on `127.0.0.1:17645` only, answers only this app's pages,
and keeps a copy of every scan under `Documents\Assessment scans`, so a failed
upload never loses pages. See `scanner-helper/README.txt` for its settings.

### Uploading image files

Without the helper, the buttons read **Upload** and take image files instead,
and on an assessment's own page you can drag files onto it. You can add several
pages at once, to the question paper and to the response separately, and click
any page to see it full size.

JPG, PNG, WEBP, TIFF, GIF and BMP are accepted, up to 25 MB per page.

## Marking with OpenAI

Uploading or scanning never marks anything. When a teacher has both a question
paper and a response, press **Evaluate** on their row: the app sends the pages
to the OpenAI API, which reads the paper and the teacher's handwriting, marks
every part of every question against the marks printed on the paper, and writes
feedback. Papers and answers can be in any language (English, Hindi, Kannada,
Sanskrit and so on); the feedback is in English. The assessment page shows the
marking while it runs, then the total, a score per section, the marks and
feedback for each part with what the teacher wrote, and strengths and areas to
improve. The assessment is marked Evaluated; you can correct any question's
marks in the Marks column, or press **Evaluate again**.

It needs the `OPENAI_API_KEY` secret on the server (on Fly:
`fly secrets set OPENAI_API_KEY=... -a teachertrainingassessments`). The model
is `gpt-6-luna` unless `OPENAI_MODEL` says otherwise. OpenAI reads JPG, PNG,
WEBP and GIF pages only, which covers everything the scanner helper produces.

## Tests, sections and grades

A **test** is one round of the assessment at a school, such as a
pre-training and a post-training test. Pick it at the top of the Assessments
page, or press **New test** to start another. A school always has at least one.

Teachers can sit any of the three sections (A, B and C), all at once or on
different dates. Each time a teacher's pages are scanned after their last
evaluation, a new sitting opens in the same test, and its sections are added
to what the teacher already has. If the whole paper is scanned but the teacher
answered only some sections, the sections with nothing written are treated as
not sat, rather than graded 0. If a section is marked twice, the latest
marking counts.

There is no overall percentage. Each section is graded on its own:

| Grade | Label      | Section percentage |
|-------|------------|--------------------|
| A     | Exemplary  | 85% and above      |
| B     | Proficient | 70% to 84%         |
| C     | Developing | 50% to 69%         |
| D     | Beginning  | below 50%          |

The bands are in `server/results.js`.

## Reports

Every Evaluate that finishes also has OpenAI write (or rewrite) two reports on
that teacher for the test, from the marks and the examiner's feedback:

- **For the teacher**: warm and practical. What went well in each section,
  next steps they can try in their own classroom, and small practice ideas. It
  takes the realities of teaching into account and never criticises.
- **For management**: factual. The evidence behind each section's result,
  strengths and gaps, responsibilities the evidence supports, recommended
  support, and the potential identifier.

Open them with **Report** on the teacher's row or from their profile; each
prints on its own. If marks are corrected or more sections are evaluated
afterwards, the page says so and **Rebuild report** brings it up to date.

Every report has the school's logo and "Teacher Training Assessment" at the
top of each printed page, and "Report generated by" with UpSchool's logo at
the foot. Reports and question papers print without the page address, date
and title the browser would otherwise add at the top and bottom of each page,
as long as the print dialog's margins are left on Default.

The **potential identifier** is worked out from the section grades by fixed
rules, so every teacher is judged the same way:

- **Mentor Potential**: exemplary (A) in every section sat.
- **Strong Performer**: proficient or better (A or B) in every section sat.
- **Strength in …**: A or B in some sections, still developing in others.
- **Developing Steadily**: C in every section sat.
- **Priority for Support**: D in a section, with no A or B anywhere.

It always says how many of the three sections it rests on.

At the end, **Management report** under the board builds the report on all of
the school's teachers in the test: section averages and grade counts, every
teacher's sections and potential, who could mentor and who needs support, which
colleagues could support each other in a section, and OpenAI's analysis and
recommendations for the school's training plan.

Reports are in English and use the same `OPENAI_API_KEY` and `OPENAI_MODEL` as
marking.

## Running it on Fly.io

The repository is set up to deploy to [Fly.io](https://fly.io): `Dockerfile`
builds the app, and `fly.toml` describes the machine, a persistent volume for
the data, and a health check.

Two things are different from running it on your laptop:

- **The data has to live on a volume.** A Fly machine's own disk is wiped on
  every deploy, so the SQLite database and the scans are kept on a volume
  mounted at `/data`, and `DATA_DIR=/data` points the app at it. Because a
  volume belongs to one machine, the app must run on exactly one machine —
  `fly scale count 1`. Two machines would quietly keep two separate databases.
- **The URL is public.** Anyone who has it can reach the app, so set a
  password: with `APP_PASSWORD` set, every page, API call and scanned image
  needs you to sign in once. Without it the app is wide open, which is fine on
  your own laptop and not fine on the internet.

First install the Fly command line tool, if you have not already:

```bash
curl -L https://fly.io/install.sh | sh            # macOS or Linux
```

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"   # Windows
```

Then, once, to set the app up:

```bash
fly auth login
fly launch --no-deploy --copy-config --name your-app-name --region bom
fly volumes create assessments_data --region bom --size 1
fly secrets set "APP_PASSWORD=a long password you choose"
```

Those four run the same in PowerShell. Keep the quotes around the whole
`APP_PASSWORD=...` argument so a password with spaces stays in one piece.

The app name has to be unique across all of Fly, so pick something specific.
Keep `--region` the same in both commands; `bom` is Mumbai.

You do not need Docker installed: `fly deploy` builds the image on Fly's own
builder unless you ask for `--local-only`.

Then, to deploy, and after any change:

```bash
fly deploy
fly scale count 1     # only needed the first time
fly open
```

Useful afterwards:

```bash
fly logs                              # what the app is doing
fly ssh console                       # a shell on the machine
fly ssh sftp get /data/app.db         # download a copy of the database
fly secrets set APP_PASSWORD='new'    # change the password; signs everyone out
```

Fly snapshots the volume daily by default, but a snapshot is not a backup you
control — download `app.db` now and then if the records matter.

## Where your data lives

Everything is inside the `data/` folder next to the code:

- `data/app.db` — the SQLite database with schools, teachers and assessments.
- `data/uploads/` — the school logos and the scanned pages.

That folder is **not** committed to git, so nothing about a real school or
teacher ends up on GitHub. To back your work up, copy the whole `data/` folder.
To start over, delete it and restart the app.

On Fly the same two live on the volume at `/data`, not in the repository.

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
Dockerfile          builds the container image for Fly
fly.toml            the Fly machine, volume and health check
server/
  index.js          the Express app
  auth.js           the optional password gate (off unless APP_PASSWORD is set)
  db.js             database connection and schema
  openai.js         the one OpenAI request, shared by marking and reports
  evaluate.js       marking the scans with OpenAI
  results.js        section results, grades and the potential identifier
  reports.js        writing the teacher, management and school reports
  generator.js      writing question papers with Gemini
  excel.js          the import template, and reading a filled-in one back
  uploads.js        file upload rules (types and size limits)
  seed.js           optional sample data
  routes/           schools, teachers, tests, assessments, reports, dashboard, generator
public/
  index.html        the single page
  css/styles.css
  img/              UpSchool's logo, for reports and question papers
  js/               router, API client, and one file per screen
```
