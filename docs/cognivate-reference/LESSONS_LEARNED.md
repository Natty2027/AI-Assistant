# Cognivate — Lessons Learned

A running log of real incidents, what actually went wrong, and what we
changed because of it. Newest entry on top. Keep entries honest about
what was *proven* vs *inferred* — several incidents in a backend like
this one are diagnosed from an incomplete log, not a stack trace, and
conflating the two wastes the next person's time.

---

## 2026-10-07 — PDF text broke `source_files.extracted_text` writes, and the production log hid the real cause

**Symptom:** A user uploaded a 399-page PDF (a PMI PMBOK Guide). Analysis
failed with a `_DrizzleQueryError` on:

```
update "source_files" set "status" = $1, "page_count" = $2,
  "extracted_text" = $3, "analysis_error" = $4
where "source_files"."id" = $5
```

This is the write in `doAnalysisPass` — see
`artifacts/api-server/src/lib/analyze.ts` (around the `extractText` call
inside the per-file `Promise.all`).

**Investigation dead end — read this before you trust a Railway log
dump:** Drizzle builds its thrown error's `.message` by concatenating
the failing SQL *and every bound parameter*, including the full
extracted PDF text. For a 399-page book that's megabytes of text in one
log line. Railway (and most hosted log pipes) truncate a line past some
length. The result: the log line we had access to ran out of room
*before* reaching the part of the error that actually said why Postgres
rejected the write — we only ever saw the query dump, never the
Postgres error code/message. **Lesson:** if an error log for a write
that carries a large text/blob value looks like it "just stops"
mid-value, assume it's truncated, not that the error has no further
detail. Don't over-index on "the log didn't show a cause" as "there
was no cause."

**Root cause (inferred from the symptom, not confirmed from this log
since the real detail was truncated out):** Postgres `text` columns
reject an embedded NUL byte (`\u0000`) outright — it fails the whole
statement, not just that value. `pdf-parse` occasionally emits stray
NUL bytes from certain PDFs (embedded form fields, bad font encodings).
A 399-page real-world PDF is exactly the kind of document likely to
trip this. The symptom (large PDF, `extracted_text` write fails,
generic driver-level error) matches this failure mode exactly.

**Fix:** added `stripNulBytes()` in `analyze.ts` and applied it to
every raw-extraction return path in `extractText` — `pdf-parse`,
`mammoth` (.docx), and the plain `text/`/`json`/`markdown` branch. Not
yet applied to the Whisper transcript path (`file.transcriptText`) —
Whisper output hasn't been observed to contain NUL bytes, so it was
left alone rather than guarded speculatively.
**Status: fixed in code, not yet deployed to Railway** as of this
writing — redeploy `api-server` before expecting a retry on this file
to succeed.

**Secondary issue, not yet fixed:** the general pattern of "the thrown
error's message contains the full payload" is not specific to this one
call site — it's how Drizzle errors work. Any future large-text write
that fails will reproduce the same "log cuts off before the useful
part" problem. Worth deciding, as a team, whether to:
- truncate `err.message` (or log `err.cause` specifically, which is
  usually the actual driver/Postgres error and much smaller) before
  logging, or
- cap `extracted_text` length at write time instead of only at LLM-load
  time (see the schema comment on `sourceFiles.extractedText` — today
  the 50k-char cap is applied in `ai.ts`'s `loadEnvContext` when
  building a prompt, not when the row is written).

Not changed yet — flagged here so it isn't re-discovered the hard way.

**Secondary issue, also not fixed, flagged for a product/legal call:**
the uploaded PDF had a PMI license stamp baked into its text layer —
`"LicensedTo:<Name>PMIMemberID:<id> This copy is a PMI Member benefit,
not for distribution, sale, or reproduction."` — repeated throughout
the document. Because extraction is verbatim, that line (with a real
name and PMI member ID) ends up in `source_files.extracted_text` in
our own database, and — when extraction fails — also in application
logs. This is a privacy/PII surface nobody designed on purpose: it's
just what "copy the PDF's text layer" does to a licensed copy. We
discussed clearing it from the affected production row(s) via
`UPDATE ... regexp_replace(...)` but **paused by the account owner's
request** before running anything — no SQL has been run against
production as of this entry. See the open thread with the user before
resuming that cleanup.

**Process lesson for whoever (human or AI) next works on this repo
through the Xcode `xcfilescontainer` sandbox:** the paths shown in the
"Project structure" system reminder (`Files/Cognivate Final/...`) are
**not real filesystem paths** — `Read`/`Edit`/`Bash` cannot resolve
them directly, and only `XcodeRead`/`XcodeWrite`/`XcodeGrep`/`XcodeGlob`
understand them. However, `XcodeWrite`'s response includes an
`absolutePath` field that reveals where the project actually lives on
disk (in this case `/Users/nathaniel/Documents/Cognivate Final/`).
Once you have that, prefer the normal `Read`/`Edit` tools for anything
beyond a single-file read or a brand-new file — `XcodeRead` returns
content with an extra layer of JSON-string escaping (backslashes and
quotes doubled), and reconstructing a multi-hundred-line file by hand
from that escaped view risks silently corrupting it. `grep`/`find` via
`Bash` do **not** see this real path by default either — it's outside
the sandboxed shell's search root — so you have to discover it via
`XcodeWrite`'s `absolutePath` (or a targeted `grep -rl <unique symbol>
/` across the whole filesystem) before you can use normal tools on it.
