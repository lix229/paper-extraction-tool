# Extraction tool

A local web app for full-text extraction: the paper on the left (PDF.js), the
extraction form on the right, with a draggable divider between them. Papers come
from `../included_papers_n63.xlsx`; full texts are looked up in Semantic
Scholar, downloaded once and cached on disk; the form is defined in `form.yaml`;
results export as CSV with one row per paper.

## Run

The paper list is an Excel workbook with one row per paper (record id, title,
authors, year, DOI, abstract and any screening columns). It is not part of this
repository: set `papers.file`, `sheet` and the column names in `config.yaml`
to point at yours.

```sh
pip install -r requirements.txt        # httpx, openpyxl, pyyaml
export SEMANTIC_SCHOLAR_API_KEY=...    # optional but strongly recommended
python3 server.py                      # then open http://127.0.0.1:8765
```

The server only listens on 127.0.0.1. Stop it with Ctrl-C; nothing is lost,
because every change is saved as you type.

## Getting the full text

Opening a paper looks it up in Semantic Scholar (by DOI, then PubMed id, then
title) and downloads its open-access PDF if one is listed. After that the cached
copy is shown, with no network access needed. **Fetch missing PDFs** in the top
bar does the same for every paper not tried yet.

Semantic Scholar does not host full texts; it points to copies on publisher and
repository sites, and many publishers block automated downloads. In a test run
on these 63 papers, 16 PDFs downloaded automatically. Of the rest, 23 have no
open-access copy, for 23 the publisher refused, showed a bot check or returned an
article page, and 1 was still rate-limited. For those, the left pane says why, links to the publisher
page, and offers a drop zone: download the PDF with your library access and drop
it in. Dropping a file onto an open PDF asks whether to replace it or add it as a
supplement (appendices often hold the country and dataset details).

A failed download is remembered and not retried on every open; use **Retry
download**. Semantic Scholar outages and rate limits are retried automatically.

Check the yellow banner when it appears: a match found by title search, or a DOI
whose record has a different title, needs confirming. Some DOIs point to the
wrong record (one in this set resolves to a whole meeting supplement). Use
**Use another identifier…** to paste a DOI, PubMed id, arXiv id or Semantic
Scholar link. A *GREEN* (repository/preprint) copy is flagged because its page
numbers can differ from the published article.

## The form (`form.yaml`)

Edit `form.yaml` and reload the page; there is no restart. The header of the file
documents every setting. In short:

- Field types: `select`, `multiselect`, `text`, `textarea`, `number`, `group`
  (repeatable items such as contexts, datasets and findings) and `ref` (links a
  finding or dataset to a context or other group item).
- `missing:` lists missing-value buttons (Not reported, Unclear, Not applicable by
  default). They are kept apart from the options, and choosing one clears the
  options.
- `show_if:` hides a field or section unless a condition holds. Hidden fields keep
  their values (the form tells you) but export blank.
- `required:` is checked when you mark a paper Complete.
- `evidence: true` adds **Use page** (inserts the page shown in the viewer, e.g.
  `p. 7`) and **Go to**. `quote: true` adds **Insert selection**, which inserts
  the text selected in the PDF as `Quote (p. 7): "…"`. Pages are PDF page
  numbers, not printed journal page numbers.

If the file has errors, the page lists them instead of the form. Field ids are
the saved keys and CSV column names, so rename labels freely, but if you rename an
id or option, the old values show up as orphaned (with a Discard button) or
flagged on the field so you can re-enter them. Bump `version` when you do; each
record stores the version it was saved with.

## Export

**Export CSV** writes one row per paper (all papers, or those shown in the
filtered list):

- paper and source columns, the original screening values (`screening_*`), the
  Semantic Scholar match, and PDF provenance (origin, URL, SHA-256);
- reviewer, status, timestamps and form version;
- one column per field, in form order. Multi-select values are joined with `; `,
  "Other" text has its own `<field>_other` column, and group items become numbered
  columns (`findings_1_type`, `findings_2_type`, …) up to the largest count.
  Links export as item codes (`C2`).
- `applicable_sections` and `hidden_values` record which parts of the form applied.

The file is UTF-8 with a BOM so Excel reads it correctly; cell text that starts
with `=`, `+`, `-` or `@` gets a leading `'` so Excel does not run it as a formula.
The codebook link in the export dialog describes every column.

## Files

```
config.yaml   paths, workbook columns, Semantic Scholar settings, port
form.yaml     the extraction form
data/
  cache/<record id>/        paper.pdf, its source (pdf.json), the Semantic
                            Scholar match (s2.json), supplements/
  extractions/<record id>.json   the extraction records (the master copy)
  settings.json             reviewer name
```

Back up `data/extractions/`. Keep `data/cache/` private: it holds copies of
copyrighted papers.

## Tests

```sh
python3 -m pytest -q
node --test tests/js/*.test.mjs
```
