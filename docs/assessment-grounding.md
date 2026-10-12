# Grounded assessments and reports

This change applies the complete-submission policy learned during report review.
It does not change previously saved scores or automatically evaluate existing
teacher records. Re-evaluate a sitting explicitly to use the new pipeline.

## Source identity and administered papers

- Bulk matching records the name, class, subject, paper title and identity
  confidence on every source page. A filename alone cannot override conflicting
  page evidence. Mixed teachers and definite identity contradictions block filing.
- A reviewer can resolve uncertain names and genuine namesakes by choosing the
  teacher. That choice cannot waive a definite conflicting name or class/subject.
- Paper level, section, subject and board compatibility are checked in bulk and
  individual assessment paths. The named/confirmed administered master is kept;
  profile ranking is a candidate aid, never a fallback answer. Weak alignment
  remains a review item. Contradictory rematches need explicit reconfirmation.
- Original PDF filename/page numbers, selected master IDs and matching evidence
  survive filing in assessment_files.source_metadata. No production scans or
  reports are included in the regression fixtures.

## Evaluation stages

1. Detect the answer languages and verify any swapped input groups.
2. Extract the selected paper into an immutable question ledger: section,
   printed identifier, source document/page, literal marks label and maximum.
   Duplicate identities, impossible page references, unreadable/ambiguous marks
   and inconsistent totals fail review. No silent rescaling is performed.
3. Infer a **provisional** source-specific rubric before seeing teacher answers.
   No approved scheme is assumed. Criterion maxima must sum to the printed
   maximum and allow half-mark credit. Assumptions are retained in the audit.
4. Transcribe and match the responses independently. Native script, errors,
   source pages and uncertainty are preserved. Empty/malformed OCR, Gemini
   failures and GIF pages fall back to the original images. The selected master
   is never changed by the response reader.
5. Mark the extracted answers against the ledger and rubric. Each positive
   credit needs an exact readable excerpt from its assigned answer. Invented
   quotes, placeholder-only credit, invalid marks and inconsistent sums fail.
6. Assess writing separately. Evidence quotes must belong to the exact question;
   at least 30 supported language words are needed for a section rating.
   Handwriting uncertainty is not a spelling error. Writing never changes marks.

Model extraction and inferred subject rubrics still need professional review;
synthetic tests establish software contracts, not real-world model accuracy.
A representative, consented pilot is appropriate before a large live batch.

## Coverage, totals and grades

| Evidence state | Scoring behavior |
| --- | --- |
| Readable answer or readable partial answer | Credit supported points only |
| Unanswered in a supplied complete section | Zero, included in its denominator |
| Entire supplied section blank | Zero, full section denominator retained |
| Entire section not supplied | Excluded from score and denominator |
| Visible but unreadable handwriting | Zero readable credit, professional note |
| Missing page, extraction failure, uncertain/mismatched paper | Stop for review |

Every uploaded response page must be accounted for. Sections are not declared
absent just because their answers are blank. Grades use the displayed two-decimal
percentage with thresholds A >=85, B >=70, C >=50, D below 50. Individual and
school reports use the same section results. Historical lenient results retain
their original interpretation until re-evaluation.

Corrections cannot award marks to a row with no readable evidence. Manual mark
changes retain the original credit audit and add an explicit correction record.

## Resume, batching and invalidation

Completed stages are persisted in evaluation_checkpoint. Failed/interrupted
work can resume only when source bytes, page order, teacher details, selected
master metadata, rubric policy, model and prompt versions are unchanged.
Sources are frozen for each attempt; changes during a request or retry wait
abort saving. Explicitly re-evaluating a completed sitting starts fresh.

Bulk queue intent is persisted in evaluation_queue, with duplicate suppression
and restart recovery. Matching and evaluation default to at most three jobs
at once (also bounded by available memory). Configure with:

- BULK_MATCHING_CONCURRENCY
- BULK_EVALUATION_CONCURRENCY

Progress and failure reasons remain available per sitting. Failed re-evaluations
are visible even when an older result exists. No live 150-teacher run is part of
this change or its tests.

Reports fingerprint full results, source bytes, paper and rubric audit, writing,
report model/prompts, school context and training configuration. Changed sources
require re-evaluation; rebuilding narrative cannot bless old scores against new
scans. Stale reports cannot be printed/exported. Stable audience filenames are
allocated by teacher identity before rendering.

## Report contract

Teacher and management reports retain the school header, original UpSchool
logo and “Report Generated by UpSchool” footer, question-level marks, response
excerpts, expected-answer guidance, professional feedback, writing feedback and
source-page appendices. Credit/Criterion/Evidence and scoring-reason tables are
not rendered. The school report has no “How to Read These Results” page.
Generation/process self-reference is removed from narrative without deleting
legitimate academic discussion of AI or changing quoted source answers.

## Verification

Run with Node 24 (the app supports Node >=22.13):

```sh
npm ci
npm run check
npm test
```

The tests use disposable databases, generated images and mocked provider
responses. No provider keys or real teacher records are required. Tests cover
real evaluation and filing call paths, source identity, master compatibility,
multilingual fallback, missing/blank coverage, exact credit evidence, totals,
cache dependencies, 150-job queue restart/deduplication and actual report DOM
rendering for teacher, management and school audiences.

The optional Chromium/PDF check requires an environment that permits its
ordinary local browser sockets; do not bypass security restrictions:

```sh
REPORT_PDF_QA=1 REPORT_QA_DIR=/tmp/tta-report-qa node --test tests/report-contract.test.js
```

The default DOM test writes self-contained synthetic HTML to
/tmp/teacher-assessment-report-qa. PDF layout and real provider quality must be
reported separately from structural/mock test results.
