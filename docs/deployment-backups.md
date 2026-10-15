# Deployment database backups

The Docker entrypoint runs `scripts/safe-start.js`. Before importing the server
or its schema-changing database module, it creates a SQLite online backup of
an existing `DATA_DIR/app.db`, including committed WAL data. A missing database
is treated as a fresh installation. Backup failure prevents server startup.

Backups live on the existing data volume under
`backups/<build-fingerprint>/attempt-<unique-id>/app.db`. Directories are private
(`0700`), database and manifest files are private (`0600`), and the source
connection is read-only. The SHA-256 build fingerprint covers deployed server,
scripts, public assets, scanner helper, and package manifests. It works even
when Fly has not set `APP_REVISION`; startup also exposes the fingerprint as
`APP_BUILD_FINGERPRINT` to the server.

Each attempt has a `manifest.json` containing its timestamp, checksum, file
size, revision, and scope. An atomic, exclusive `complete.json` in the release
directory points to the verified attempt. Repeated starts of the same build
validate and reuse it rather than creating more backups. Interrupted attempts
remain intact, and retries use new filenames. A corrupt completed backup or
manifest blocks startup instead of silently replacing it.

The backup is checked with SQLite `integrity_check`, hashed, and flushed before
publication. Startup requires room for the logical database plus a reserve of
at least 256 MiB or 10% of the database size, whichever is larger. It also checks
space during copying and after completion. Source growth or other processes
may still consume space; any resulting backup error fails closed.

There is no automatic retention deletion. Operators must monitor volume usage
and separately arrange any approved archival or cleanup. Failed/interrupted
attempts also consume space and are intentionally preserved.

This is a database-only, same-volume backup, not a volume snapshot or an
off-volume disaster-recovery copy. Uploads, original scans, and other source
files stay on the volume and are not copied. A backup is taken once per build,
not on every idle restart or redeploy of identical files. Existing backups are
never overwritten or deleted by this script.

For a restore, first stop all database writers. Validate the selected manifest
and checksum, preserve the current database and its WAL/SHM files separately,
and use the selected backup as a coherent standalone database. Restoration is
an operator action; the startup script never performs it automatically.

`npm start` remains the development/direct-server command. Production Docker
startup uses the guarded entrypoint; overriding its command bypasses the guard.
