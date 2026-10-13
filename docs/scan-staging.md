# Safely stage a scanned PDF ZIP

This is an operator tool, not a new upload endpoint. It preserves original
PDFs on the app's data volume and gives a reviewable manifest. It **does not
import into the bulk review queue**, assign teachers, render pages, match
question papers, evaluate, file assessments, regenerate reports, or open the
database. No credentials are needed by this script.

## Preview, then explicitly apply

Run on a machine containing the source ZIP and the app's installed Node
dependencies. Node 22.13+ is required, as for the app.

```sh
node scripts/stage-scans.js /path/to/scans.zip --expected-teachers 168 > preview.json
```

The default is read-only. The shell redirection above is optional and is the
only write in that dry-run command. Inspect the preview before applying:

```sh
DATA_DIR=/data node scripts/stage-scans.js /path/to/scans.zip \
  --expected-teachers 168 --apply --confirm-sha256 ARCHIVE_SHA_FROM_PREVIEW
```

Use exactly the same archive and expected teacher declaration on retries.
Originals are stored at
`DATA_DIR/scan-staging/<archive-sha256>/originals/<pdf-sha256>.pdf`.
The completed `manifest.json` is written last. Existing PDFs and manifests
are checksum-verified, never overwritten. A changed declaration or conflicting
manifest stops rather than rewriting an audit record. An interrupted apply
can be repeated safely: already-published objects are reused. A crash can
leave `.partial` files; these are never used as completed originals. Remove
those only after verifying no staging process is running and obtaining any
required deletion authorization. Disk checks conservatively allow for all
unique PDFs even on retry.

The original ZIP is read in place and is not copied by this tool. Retain it
separately if the full archive, including excluded non-PDF attachments, needs
to be preserved. Every PDF member name is retained in the manifest even when
identical bytes occur under multiple names. Non-PDF members are listed and
not extracted. ZIP member names are never used as filesystem paths.

## What the counts mean

- `pdf_files`: PDF entries in the ZIP, including byte-identical duplicates.
- `unique_pdf_objects`: distinct original PDF byte streams.
- `pages_including_duplicate_files`: parsed page counts across all PDF entries.
- `pages_in_unique_pdf_objects`: page counts with byte-identical files counted once.
- `expected_teachers_declared`: an optional operator-provided expectation.
- `verified_teacher_identities`: `null`, because this tool does not read identities.
- `imported_bulk_items`: zero. `staged_not_imported` is not an import success.

For example, 173 PDFs and an expectation of 168 teachers do not establish 173
teachers or 168 verified identities. Split packets, mixed-teacher packets,
repeated scans and multiple subject papers must remain distinct evidence until
the existing identity-aware pipeline reviews them. Page count parsing does
not verify that every page can be rendered.

## Limits and safety

The CLI supports ordinary single-disk ZIPs with stored or deflated members.
It rejects ZIP64, encryption, symlinks/special files, overlapping members,
traversal/absolute/ambiguous paths, local-header inconsistencies and invalid
UTF-8 names. Legacy non-ASCII names require a correctly UTF-8 encoded archive.
PDF members are streamed one at a time, checked against declared size and
CRC32, hashed with SHA-256, and parsed with the installed PDF.js. At most one
PDF is buffered for parsing at a time; the entire archive is never buffered.
Malformed or encrypted PDFs stop the operation before staging starts.

Defaults: archive below 4 GiB; at most 5,000 ZIP entries; 16 MiB directory;
256 MiB per member; 8 GiB total expanded data; maximum compression ratio
200:1; 256 MiB free-disk reserve plus the original-PDF storage requirement.
The module exposes limits for deliberate operator-controlled use, but the CLI
does not silently relax them. Archive metadata is untrusted and output size
is enforced while inflating. All paths below the resolved DATA_DIR staging
root must be real directories. Existing stored files must be regular files.
The destination filesystem must support hard links for exclusive publication.

Keep the DATA_DIR filesystem private to the app/operator while staging.
The tool is not a sandbox against a privileged process concurrently replacing
directories or editing the source ZIP. It uses private file/directory modes,
rejects source-file symlinks, and revalidates source checksums before publishing.

## Next step: bulk upload is separate

**First reconcile against existing bulk rows.** Files may already be waiting
to be filed. An assessment screen saying "Nothing uploaded" can describe the
filed-assessment stage, not an empty bulk queue. That is not a reason to
upload the same PDFs again. Compare source filenames, page counts and
available source hashes with the existing queue, preserving split and mixed
packets. Recheck current production state before deciding any file is missing.
Staging and its manifest are optional audit aids, not evidence that reimport
is needed, and neither the script nor app startup initiates grading.

The existing browser upload (`public/js/views/bulk.js`) renders PDF pages as
JPEGs with PDF.js (short edge 1700 pixels, quality 0.85), then posts page images
to `/api/bulk` with an explicit school, test and original PDF filename.
`bulk.addItem` expects those page-image files, **not original PDF bytes**.
Use that existing flow for the subsequently authorized import, preserving the
manifest's mapping from original archive member to source SHA. PDFs over the
120-page upload limit are flagged in the manifest and require a deliberate
handling decision; never silently split or truncate them.

Do not feed this ZIP to the question-paper-pack import endpoint. That endpoint
expects a different kind of manifest and is for question-bank papers.

For a container deployment, make the CLI available by copying `scripts/`
alongside `server/` in the Docker build stage. Staging itself must be explicitly
run after deployment; app startup never executes it.

## Focused verification

```sh
node --test tests/scan-staging.test.js
npm run check
```
