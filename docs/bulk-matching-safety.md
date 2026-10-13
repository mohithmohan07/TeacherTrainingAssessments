# Bounded bulk matching

Matching does not file responses, evaluate teachers, or change existing grades.
Test a representative packet with **Match again** before starting a whole batch.
Inspect the source-page identity and question-paper assignments afterward.

## Identity and page evidence

The first read sends at most eight answer images per request. Each request has
an explicit local-to-original page map; missing, duplicate, or out-of-range
observations fail closed. Flagged identity fields and reported paper headings
receive one focused reread, at most four images per request. Blank identity
boxes are distinguished from nearby equations and answer-body headings.
A reread cannot erase a certain name or a previously resolved different teacher,
including namesakes distinguished by class or subject. Unresolved conflicts
stay available for source review. The source images are never rewritten.

A certain full name that matches exactly one roster teacher may receive one
independent visual class/subject verification when its copied metadata conflicts.
The first reading locates the identity panel; a bounded context-preserving crop
and the untouched full page go to the existing Gemini provider without expected
roster class/subject values. At most four pages per packet use this check, with
no transient retry. The independent name must match exactly. Clear genuine
metadata stays authoritative; answer notation is excluded; uncertain metadata
stays unknown and cannot disambiguate namesakes. Missing provider, invalid crop,
malformed evidence, or a different/uncertain name cannot clear the conflict.
Original and verified field evidence plus exact crop coordinates remain in the
operator drawer. Neither source bytes nor teacher reports are modified.

If identity verification stops the run, the UI says question-paper comparison
has not run. It does not claim every page returned an incomplete match map.

## Limits and usage

Each explicitly requested packet match has a 15-minute admission deadline,
at most 40 actual provider attempts, and at most 90 seconds per HTTP attempt.
Regular matching passes one transient retry to its providers. Every retry and
Gemini format fallback consumes the same packet budget. Calls already admitted
finish or time out within their remaining deadline. Model token usage is stored
when returned; missing usage remains unknown rather than zero. Saving usage
fails closed. Restarting a running job preserves consumed attempts and expiry.
An explicit new Match again starts a fresh budget, retaining five prior summaries.

The UI displays attempts, elapsed time, reported tokens, and candidate count.
These are usage facts, not a dollar price. Failed/timed-out requests may have
unreported billable usage. Existing evaluation/finalization limits are unchanged.

The read-only `GET /api/bulk/match-plan?school_id=...&test_id=...` previews eligible
packets, page counts, compatible candidates, and logical call estimates.
For P source pages and C candidates, the baseline is ceil(P/8) identity calls
plus ceil(C/8) bank calls and, when C > 8, one final comparison. Focused rereads
can add up to ceil(P/4), and independent context checks up to min(P,4); OCR, format fallbacks and transient retries add calls within the cap.
A multi-packet `POST /api/bulk/match` requires the current preview's `plan_id`.
If source/library state changed, a stale plan returns 409 and queues nothing.
The UI asks the operator to review this plan before starting the batch.

## Safe rollout

1. Deploy a tested revision using the existing volume and resources. The
   pre-start backup must complete and the health fingerprint must match.
2. Retry one representative existing bulk item. Check original source pages,
   teacher identity, matched masters, all page assignments and usage.
3. Investigate any remaining unresolved evidence before expanding the batch.
4. Review a fresh matching plan before any wider run. Filing and evaluation
   remain separate operator actions; do not re-upload an existing source batch.
