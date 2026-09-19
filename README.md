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
