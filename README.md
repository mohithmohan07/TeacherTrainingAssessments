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

You need [Node.js](https://nodejs.org) 22.13 or newer. Check with `node --version`.

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

**Download all reports** prints the reports with Chrome, Edge or Chromium,
which it looks for where they are usually installed. If yours is somewhere
else, set `CHROMIUM_PATH` to the program.

## Importing teachers from Excel

1. Open a school, and click **Download Excel template**.
2. Fill in one teacher per row on the *Teachers* sheet: teacher name, grade and
   subjects. The name is the only required column. There is a *How to use*
   sheet with examples.
3. Save the file and upload it under **Bulk import teachers**.

The import tells you how many teachers it added, and lists any rows it skipped.
Rows with no name are skipped, and so is anyone already on that school's list,
so you can safely re-upload a file you have added a few rows to.

## The paper library

The **Paper library** page keeps the question papers teachers sit, once each,
as PDFs labelled with their sections, subject, levels, board and language. On
the Assessments board, a teacher with no question paper yet is shown the
library paper that best fits their class, subject and school board, with
**Confirm paper**. That opens the paper beside the other choices and asks
whether it is the one the teacher sat; pick another if not, then press **Yes,
use this paper** and upload the answer paper. Nothing is used until it is
confirmed, and **Change paper** puts a different one in. OpenAI reads a library
paper as the PDF itself, so the question paper needs no scanning.

Papers come in one at a time (**Add a Paper**, with a PDF; save a Word paper as
PDF first) or many at once from a **paper pack**: a `.zip` holding the PDFs,
an optional first-page picture of each, and a `manifest.json` of their labels:

```json
{
  "format": "tta-paper-pack",
  "version": 1,
  "papers": [
    {
      "file": "papers/icse-middle-science-b.pdf",
      "preview": "previews/icse-middle-science-b.png",
      "title": "ICSE Middle School Science · Section B",
      "sections": ["B"],
      "subject": "Science",
      "levels": ["middle-school"],
      "board": "ICSE",
      "language": "English",
      "total_marks": 35,
      "notes": "",
      "priority": 1
    }
  ]
}
```

Levels are `pre-primary`, `primary`, `middle-school`, `secondary` and
`senior-secondary`; none means any level. The board is `CBSE`, `ICSE`,
`Karnataka State`, `Karnataka Pre-University`, or empty for any. `priority`
breaks ties between near-identical papers, higher first. Importing a pack
again skips papers already in the library, and a paper some sitting uses
cannot be deleted. Packs are for papers kept out of this repository: they
live in the app's data folder, not on GitHub.

## Uploading scans

The board works on the **Full paper** or on **Section A**, **B** or **C**.
With a section picked, each row takes that section's question paper and
answer paper only, and Evaluate marks just that section; it adds to the
teacher's results in the test like any other sitting.

Each teacher's row on the **Assessments** page has an Upload button for the
question paper and one for the answer paper (the teacher's response). They
either scan straight from the scanner or upload image files. Once pages are in,
the first one shows small beside the count, so pages in the wrong column are
easy to spot: **Swap** on the row (or on the assessment's own page) swaps the
question paper and the answer paper, and pressing it again swaps them back.

Clicking the small page shows every page of that paper, fitted to the screen,
under the name of the teacher they are filed under: **Zoom in** (or a click on
the page) shows a page full width to read, the arrows go through the pages,
and **Close**, Escape or the browser's Back button closes them. Pages filed
under the wrong teacher can be moved from there with **Wrong teacher? Move
these pages**, or with **Move to another teacher** on the assessment's own
page: pick the teacher, and they go to that teacher's sitting in the same test
and section, after any pages it already has. A paper that has been marked
keeps its pages.

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
   While the scanner works, a dialog names the teacher the pages will be filed
   under; if it is the wrong one, press **Stop** and nothing is filed.
   **Both sides** scans both sides of each sheet and drops blank backs.

The helper listens on `127.0.0.1:17645` only, answers only this app's pages,
and keeps a copy of every scan under `Documents\Assessment scans`, so a failed
upload never loses pages. See `scanner-helper/README.txt` for its settings.

### Uploading every answer paper at once (PDFs)

**Upload all answer papers (PDFs)** on the Assessments page takes every
teacher's scanned answer paper in one go: one PDF per teacher, chosen together
with **Upload files** or dropped on the page. The browser turns each PDF's
pages into pictures and uploads them. The PDFs need not say whose answers they
are, which sections they cover or which paper was sat; each one is sorted:

1. **The teacher** comes from the file name ("Keshava.pdf",
   "Archana_BM.pdf"), or else from the name written on the sheets, which
   OpenAI reads while it checks the language of each page.
2. **Pages not in English** are read by Gemini first, in their own script, as
   Evaluate does. A teacher can write one section in Kannada and another in
   English: each section is matched on its own.
3. **Sections and papers**: OpenAI compares the answers with the library papers
   that fit the teacher (their level, subject and board), using what each
   answer talks about, the names and terms in it and the order of the
   questions, to say which section each page answers and which paper each
   section was sat on. A section with no pages was not sat.

Nothing is filed until it is checked. Each PDF shows its teacher, its pages
coloured by section and the question paper chosen for each section, all of
which can be changed; **Preview** shows a section's question paper beside the
teacher's answers to it. **File** puts each section's pages under the
teacher's sitting for that section, with its question paper. Filing marks
nothing: **Evaluate all** (with one Standard or Lenient choice) marks the
sections just filed, two at a time, or each can be evaluated on its own.
PDFs not yet filed wait on the page for the next visit.

### Uploading image files

Without the helper, the buttons read **Upload** and take image files instead,
and on an assessment's own page you can drag files onto it. You can add several
pages at once, to the question paper and to the response separately, and click
any page to see it full size.

JPG, PNG, WEBP, TIFF, GIF and BMP are accepted, up to 25 MB per page.

## Marking with OpenAI

Uploading or scanning never marks anything. When a teacher has both a question
paper (scanned, or confirmed from the paper library) and a response, press
**Evaluate** on their row: the app sends the pages
to the OpenAI API, which reads the paper and the teacher's handwriting, marks
every part of every question against the marks printed on the paper, and writes
feedback. For every part it also says briefly what was asked and what a
full-marks answer contains. Papers and answers can be in any language
(English, Hindi, Kannada, Sanskrit and so on); the feedback is in English, and
an answer that has to be in the paper's language is given in it. The
assessment page shows the marking while it runs, then the total, a score per
section, the marks and feedback for each part with what was asked, what the
teacher wrote and what should have been answered, and strengths and areas to
improve. The assessment is marked Evaluated; you can correct any question's
marks in the Marks column, or press **Evaluate again**. If the question paper
and the answer paper were plainly uploaded the wrong way round, OpenAI marks
them the right way round and the app swaps the pages back, saying so above the
marks.

Before marking, OpenAI looks at the answer pages and says what language the
answers are written in. Answers all in English are read and marked by OpenAI
from the scans, as above. Answers in another language, or in English mixed
with another (even a word or a line), are read by Gemini first: it writes down
each page in the teacher's own language and script, without translating or
correcting it, and OpenAI marks that reading the same way. The note under the
marks says which it was and names the languages. A sitting marked before this
check keeps its marks until you press **Evaluate again**.

Evaluate first asks how the marks are counted. OpenAI marks every answer the
same way in both:

- **Standard**: every question counts. A question the teacher did not attempt
  scores 0 and stays in the total, so 20 marks out of a 35-mark section is 57%.
- **Lenient**: questions the teacher did not attempt (nothing written, no
  marks) are left out of both the marks and the total. If 10 of those 35 marks
  were not attempted, 20 out of the remaining 25 is 80%.

The dialog starts on the last choice made on that computer, or on how the
sitting was marked when you press Evaluate again. Lenient sittings say so on
the board, the assessment page, the teacher's profile and every report, with
how many questions and marks were left out. Changing a question's mark from 0
counts it again. To switch an evaluated sitting between the two, press
Evaluate again and choose the other.

### Written Expression

Once the answers are marked, Evaluate also has OpenAI check how well they are
written, apart from whether they are right: **Written Expression**. Each
section the teacher wrote in gets four scores out of 5 (Sentence Formation,
Grammar, Spelling and Punctuation, Word Choice) and a score out of 10 from
them: Excellent 8.5 and above, Good 7 to 8, Fair 5 to 6.5, Needs Practice
below 5. Only answers written in words count; option letters, one-word
answers and drawings are left out, and a section with too little writing says
so instead of a score. Answers are judged in the language they are written in,
from the scans for answers in English and from Gemini's reading for the rest.
It changes no mark, grade, total or potential identifier, and a check that
fails leaves the marks in place.

The score shows on the teacher's row on the board, on the assessment page and
on the profile. Clicking it opens the errors found: for each, the question,
the kind of error and what is wrong, the teacher's own words and the
correction. Both of a teacher's reports carry the score in the results table
and the same list under **Written Expression**, before Question by Question.
Papers marked before the check get it when their reports are next built (or
with **Check the writing** on the assessment page), judged from what the
marking wrote down of each answer; their marks stay as they are.

The School Report has a short **Written Expression** section too: the
school's average score, teachers by level, the average of each of the four
scores and the most common kinds of error, then a few lines on where teachers
usually fall short in their writing and how to improve it, written by OpenAI
from the figures and some of the errors found. It does not name teachers.

It needs the `OPENAI_API_KEY` secret on the server (on Fly:
`fly secrets set OPENAI_API_KEY=... -a teachertrainingassessments`). The model
is `gpt-6-luna` unless `OPENAI_MODEL` says otherwise. OpenAI reads JPG, PNG,
WEBP and GIF pages only, which covers everything the scanner helper produces.
Answers that are not all in English also need the `GEMINI_API_KEY` secret, the
one the assessment generator uses; Gemini is `gemini-3.8-flash` unless
`GEMINI_MODEL` says otherwise. Gemini cannot read GIF pages, and takes answer
pages of up to 12 MB each.

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

| Grade | Label          | Section percentage |
|-------|----------------|--------------------|
| A     | Excellent      | 85% and above      |
| B     | Good           | 70% to 84%         |
| C     | Fair           | 50% to 69%         |
| D     | Needs Practice | below 50%          |

The bands are in `server/results.js`.

## Reports

Every Evaluate that finishes also has OpenAI write (or rewrite) two short
reports on that teacher for the test, from the marks and the examiner's
feedback. Both are in simple English and open with a summary and the results:
each section's marks and grade, with a score bar showing where the score falls
among the grade bands. Both end with **Marks for Every Question**, a compact
grid of every question's marks with the blank answers marked, and a key to the
grades, then **Question by Question**, which starts on a new page when
printed: for every question, what was asked and its marks, what the teacher
answered and what should have been answered. Last comes **Evidence**: for
each sitting behind the results, the question paper (the library paper
confirmed for it, or its scanned pages) and the teacher's answer paper, each
page printed on a page of its own. The pages are made smaller in the browser
first, so a printed report stays a few megabytes. A page uploaded as a TIFF
file cannot be shown; the report says so in its place.

- **For the teacher**: warm and practical. What went well, the teacher's next
  steps and a few ideas to practise in their own classroom. It never
  criticises and has no training plan.
- **For management**: factual. The training recommended (or that none is
  needed), the potential identifier, numbered findings, what UpSchool will do
  about them, what the school needs to provide and the goal for the final
  test, each in a line or two. The day-by-day **Training Plan** follows (see
  [Training plans](#training-plans)).

Open them with **Report** on the teacher's row or from their profile; each
prints on its own. **Build N teacher reports** in the **Reports** card on the
Assessments page builds every teacher report in the test that is missing or
out of date in one go, a few at a time. If marks are corrected, more sections
are evaluated or the growth paths change afterwards, the report says so and
**Rebuild report** brings it up to date. Reports written in the earlier,
longer layout show only the results until they are rebuilt, and the button
picks them up too.

**Download all reports** in the same card puts every written report in the
test into one zip named after the test. `Test 1 results.zip` holds a
`Test 1 results` folder with each teacher's own report in
`Reports for Teachers`, each management report in `Reports for Management`,
and `Overall School Report.pdf`. The server prints them to PDF with Chromium,
a few seconds a report, and the zip downloads when it is ready. The card then
lists any teacher left out because their report has not been written or is in
the earlier layout, and any report in the zip that is out of date. The zip can
be downloaded again for an hour.

Papers marked before the marking said what should have been answered get it
when their reports are next built: OpenAI reads the question paper again with
the marks and feedback it gave, and works out what was asked and what a
full-marks answer contains for each question. No mark changes. Reports
written before then say so and count as out of date, so **Build N teacher
reports** picks them up. If that cannot be done for a sitting (OpenAI fails,
or its question paper has been removed), the report is still written with the
examiner's feedback in place of the answer, and says why on screen.

Every report has the school's logo and "Teacher Training Assessment" at the
top of each printed page, and "Report generated by" with UpSchool's logo at
the foot. Reports and question papers print without the page address, date
and title the browser would otherwise add at the top and bottom of each page,
as long as the print dialog's margins are left on Default.

Every report is written in plain, everyday words that anyone can follow
without the question paper or the teacher's answers to hand. OpenAI is told
never to cite question numbers or marks in its text (the tables show them),
to say instead what the teacher was asked and what they did or missed, to
avoid teaching jargon and to explain any term it cannot avoid. Sections are
called by their full names in the text, the same for every teacher, never by
a letter alone, and what a teacher needs to work on (and the training plan's
topics) is the wider skill the missed questions belong to, not one item from
one question. Reports written before then say so on screen and count
as out of date, so **Build N teacher reports** picks them up; the names of
grades, needs and the potential identifier change on every report at once.

The **potential identifier**, headed **Strengths and Potential** in the
reports, is worked out from the section grades by fixed rules, so every
teacher is judged the same way:

- **Can Guide Other Teachers**: A in every section sat.
- **Strong in Every Section**: A or B in every section sat.
- **Strong in Section …**: A or B in some sections, C or D in others.
- **Fair in Every Section**: C in every section sat.
- **Needs Help First**: D in a section, with no A or B anywhere.

It always says how many of the three sections it rests on.

The school report sorts teachers by **need** and **stage**, both by fixed
rules. The need matches the training: teachers doing well need no growth path.

- **Doing Well**: B or better in every section taken.
- **Needs Some Support**: a section at C, none at D.
- **Needs More Support**: a section at D.

A teacher's stage comes from the class typed in their **Grade**: Pre-Primary
(Nursery to UKG), Primary (Classes 1 to 5), Middle School (6 to 8), High
School (9 and 10) or PUC (I and II PUC). Someone who teaches across stages is
counted in the highest, and a teacher whose Grade names no class shows under
**Classes Not Given**.

At the end, **School Report** in the Reports card (or on the dashboard) opens
the report on all of the school's teachers in the test. Its first page has a
summary, a pie chart splitting the teachers into Doing Well, Needs Some
Support and Needs More Support, and each section's average score in every
stage, with how many need more support there. Then come each section's grades as bars, OpenAI's findings, a
plan of action with timings and how UpSchool's team runs it, the training days
in all, what the school needs to provide, and every teacher sorted by stage
and need, each name linking to their report. The charts and figures are live;
**Build report** adds the written parts.

Reports are in English and use the same `OPENAI_API_KEY` and `OPENAI_MODEL` as
marking.

## Training plans

The training the management reports recommend comes from UpSchool's growth
paths, set up once on the **Training paths** page. Choose the training proposal
as a PDF and press **Read PDF**: OpenAI fills in each path's name, what it
covers and how many days it runs, the exit assessment and any support after
the training, leaving out prices and names. Check them and press **Save**, or
type them in by hand. The paths are kept in the app's database, not in this
repository, and the reports never mention the proposal.

A teacher's path is picked from their section grades by fixed rules, with the
paths ordered from the shortest to the longest:

- **No path**: Good (B) or better in every section sat.
- **The first path**: one section at C or D.
- **The second path**: two or more sections at C or D, but fewer than two at D.
- **The third path**: two or more sections at D.

With fewer paths, the longest stands in for the missing ones. The days are
fixed by rules too, so they always add up: each section needing support asks
for days (6 at grade D, 4 at C), plus a day of classroom application for each
and a review day, kept within the path's range. The plan takes the section
that needs most support first, then classroom application with coaching, then
review and readiness for the final test. OpenAI writes what the teacher works
on in each block of days, how UpSchool's team does it and which of the
report's findings it answers. The goal for the final test is one grade up in
each section the plan works on, for example at least 50% (Grade C) where a
teacher had a D.

Reports built before the paths were saved, or before they were changed, say so
on screen, and the Reports card counts them as out of date; **Rebuild report**
brings the training plan up to date.

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

The image also has Chromium's headless shell in it, which prints the reports
for **Download all reports**. While it prints, Chromium needs up to about
250 MB besides the app's own 150 MB or so, which fits in the machine's 512 MB.
If a zip ever fails for lack of memory, give the machine 1 GB
(`memory = '1gb'` under `[[vm]]` in `fly.toml`).

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

- `data/app.db` — the SQLite database with schools, teachers, assessments,
  reports and the growth paths.
- `data/uploads/` — the school logos, the scanned pages and the paper
  library's PDFs.

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
- **PDF.js** draws the library's question papers in the reports' evidence
  pages, and **Puppeteer** has Chromium print the reports for Download all
  reports.

```
Dockerfile          builds the container image for Fly
fly.toml            the Fly machine, volume and health check
server/
  index.js          the Express app
  auth.js           the optional password gate (off unless APP_PASSWORD is set)
  db.js             database connection and schema
  openai.js         the one OpenAI request, shared by marking and reports
  evaluate.js       marking the scans with OpenAI
  reading.js        the answers' language, and Gemini reading those not all in English
  answers.js        what should have been answered, for papers marked before the marking said
  writing.js        Written Expression: how well the answers are written, and the errors
  paper-inputs.js   a sitting's papers as OpenAI input, for marking and answers
  papers.js         the question paper library: labels, suggestions, pack import
  results.js        section results, grades and the potential identifier
  reports.js        writing the teacher, management and school reports
  bundle.js         Download all reports: every report printed to PDF, in one zip
  zip.js            writing zip files
  training.js       growth paths, and each teacher's and the school's training plan
  generator.js      writing question papers with Gemini
  excel.js          the import template, and reading a filled-in one back
  uploads.js        file upload rules (types and size limits)
  seed.js           optional sample data
  routes/           schools, teachers, tests, assessments, papers, reports, training, dashboard, generator
public/
  index.html        the single page
  css/styles.css
  img/              UpSchool's logo, for reports and question papers
  js/               router, API client, the report charts, the evidence pages, and one file per screen
```
