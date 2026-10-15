# Content matching and identity review

The matching queue compares answer content against the entire supplied paper bank. A name, class, subject, board, filename or teacher profile cannot remove a paper from discovery or prevent comparison. Matching does not file responses, select a new teacher, change profiles, or grade answers.

## Evidence

Each run records the original page IDs/order and SHA-256 hashes, every master ID/hash, parser/screening/prompt versions, model, coverage mode, all surviving candidates, final full-master verification, per-section reasons/question labels/page IDs, confidence and alternatives. Comparison completion is distinct from a unique match. Identical answered questions or equivalent masters remain ambiguous; partial answer coverage is legitimate and omitted answers are not fabricated.

The UI displays Content Match and Identity Review separately. Existing source-identity, profile, exact-master and filing guards remain active. A successful content match may still need identity or administered-version review.

## Bounded comparison and reuse

Complete PDF text extraction is cached by source bytes and parser version. Only conservatively text-complete PDFs may be screened using their entire extracted text; no keyword/top-K filter discards other bank entries. Images, diagrams, annotations, uncertain extraction and oversized text fall back to full-PDF screening. Every plausible candidate is verified against its actual full PDF and original answer images. Coverage distinguishes text screening from full-PDF screening.

Equivalent content groups retain every original master ID. Different marks, rubrics, punctuation or page structure are not silently merged. Too many contenders, incomplete coverage, provider failures or budget exhaustion stop without accepting a partial winner.

Completed per-packet comparison results are reusable only when exact source page IDs/order/bytes, full bank IDs/bytes/metadata, parser/screening/prompt versions and model are unchanged. A changed source invalidates old identity evidence as well. Reuse recomputes current filing guards; it cannot override an identity conflict.

The existing packet attempt/deadline caps and global queue limits remain unchanged. No deployment or paid batch run is implied by this implementation.

## Source scope and formats

A source folder's file count is not proof of equivalence with application records. Before a production batch, verify the scan inventory, question-paper inventory and import mapping. DOCX originals require a verified, provenance-preserving PDF representation for full-master comparison; they must not be silently skipped or treated as complete from text alone. The historical 173 scans, earlier 123 credit-limited cohort, 78 Drive paper files and 120 application master records are distinct inventories until reconciled.

## Current limitations

A later explicit retry can resume validated, completed screening batches after a provider failure or timeout. The checkpoint key binds original answer bytes/order, the complete bank bytes/order/metadata, engine/parser versions, prompts/schema, provider/model and request settings. A timeout-split batch is reusable only after both halves finish and validate; partial halves are re-screened. Invalid or stale checkpoint records are re-screened. Resumed attempts always perform a fresh full-PDF final comparison for all surviving candidates, and coverage records reused versus fresh screening IDs. An already completed, byte-identical whole-packet result retains its separate existing reuse policy. No checkpoint alone is a final match. Browser rendering QA must be run in a supported browser before rollout; local DOM tests are not a substitute for the live interaction check.

New packets or legacy identity observations without trusted source-byte binding remain explicitly unfileable. This change does not introduce an identity-only verification route. The retained legacy identity sorter is internal code/test coverage, not a user-facing verification action; a separate reviewed identity workflow is required before filing those packets.

## Explicit confirmed-source bank

A test can activate an immutable, source-confirmed bank using the matching card's verified-bank ZIP import. The ZIP includes manifest.json with every original source alias and canonical PDF, source/PDF hashes, conversion method and validation status. All files validate before writes; missing entries, changed hashes or incomplete provenance reject the pack. Exact PDF duplicates share a master but keep every source alias in the manifest.

Import is additive: byte-identical existing masters are reused only after their actual stored files match. Missing masters are added without invented section labels. Existing master labels, grading configuration and assessment records are not overwritten. Newly imported sources need separate section/filing review before grading; content matching does not provide that approval.

Master insertion and school/test bank activation form one transaction. Failed writes roll back the selection and new rows and remove only files created by the attempt. Activation checks are repeated after asynchronous unpacking to reject concurrent bank changes or a newly started matching queue.

The selected bank's manifest SHA-256, original source count, distinct PDF count and source-folder link are visible on the matching card and approval plan. Plans, source freshness and retry keys include the selected bank signature. If a selected master disappears or its bytes change, matching fails closed without falling back to the whole application library. Unrelated tests without an explicit bank retain their existing library scope.

Content-only final evidence requires `master_pages`: physical, one-based page anchors in the matched PDF. The validator rejects missing or out-of-range anchors for a proposed master. Combined source PDFs remain intact; findings identify the contained paper's supported page numbers and question labels rather than implying every paper in a collection was administered. The UI distinguishes these master pages from scanned-answer source page IDs.
