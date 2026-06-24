# OEFA / Poder Judicial — JSF Jurisprudence Scraper

A TypeScript web scraper that navigates a **JSF / PrimeFaces** jurisprudence
repository, extracts every document's metadata, and downloads the associated
PDFs — using **only HTTP requests + HTML parsing** (no browser automation).

It targets two structurally identical sites:

| Site | URL | Access |
|------|-----|--------|
| **Poder Judicial del Perú** (primary) | `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | Requires a **Peru VPN** (geo-restricted, returns HTTP 403 otherwise) |
| **OEFA — Tribunal de Fiscalización Ambiental** (default) | `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | Public, **no VPN required** |

Both run the same JSF/PrimeFaces stack, so the scraper works against either —
just point `--url` at the one you want. The default is the OEFA site so the
project is runnable out of the box.

> Built with `axios` + `cheerio` only, as required. **No Puppeteer / Playwright /
> Selenium or any browser/WebDriver library is used.**

---

## How the site actually works (the challenge)

These pages are not static HTML — they are stateful **JSF (JavaServer Faces)**
applications using **PrimeFaces 6** AJAX. Reverse-engineering the protocol was
the core of the challenge:

1. **Session bootstrap** — a `GET` returns a `JSESSIONID` cookie and a
   `javax.faces.ViewState` token embedded in the form. Every subsequent request
   must echo both.
2. **Search** — the result table is empty on load. A **PrimeFaces AJAX postback**
   on the *Buscar* button (`javax.faces.partial.ajax=true`, `source=<button>`)
   returns the first page of results and the **total record count** (e.g. 1 753).
   The response is an XML `partial-response`; a **refreshed ViewState** comes back
   with it and must replace the old one.
3. **Pagination** — another AJAX postback (`source=<table>`, `<table>_first=N*10`,
   `<table>_rows=10`) returns the next page. Crucially, pagination responses
   contain **bare `<tr>` rows** with no `<table>` wrapper, which HTML parsers
   silently drop — the parser wraps them before reading.
4. **PDF download** — each row has a `mojarra.jsfcljs` command link carrying a
   `param_uuid`. A **full (non-AJAX) form `POST`** with that link id + uuid
   streams back the PDF (`Content-Disposition` gives the original filename).
   The link id embeds the row's index, so JSF only resolves it when the table's
   **server-side current page matches the row** — the scraper therefore
   *positions the table on the right page before downloading its rows*.

All of this is discovered/handled in [`src/jsfClient.ts`](src/jsfClient.ts) and
[`src/parser.ts`](src/parser.ts).

---

## Features

- ✅ Full navigation: search + paginate through **all** result pages.
- ✅ Extracts every column (expediente, administrado, unidad fiscalizable,
  sector, nro. resolución, uuid) to **JSON and CSV**.
- ✅ Downloads PDFs with **descriptive filenames**
  (`<seq>__<expediente>__<resolucion>__<uuid8>.pdf`).
- ✅ **429 (Too Many Requests) handling** with exponential backoff + jitter,
  honoring the `Retry-After` header (also retries `408`/`5xx`/network errors).
- ✅ **Continues past persistent failures** and writes them to
  `failed-downloads.json`, re-runnable via `--retry-failed`.
- ✅ **Resumable**: existing PDFs are skipped.
- ✅ Polite, configurable delays between requests.
- ✅ Strongly-typed, modular, documented code.

---

## Requirements

- **Node.js 18+**
- npm

## Installation

```bash
git clone <this-repo-url>
cd scraper-challenge
npm install
```

## Usage

Run directly with `ts-node` (no build step needed):

```bash
# Smoke test: first 2 pages of metadata + their PDFs (recommended first run)
npm run scrape -- --pages 2

# Extract ALL metadata, no PDF downloads
npm run scrape -- --no-pdf

# Full run: all pages + all PDFs (long-running; resumable)
npm run scrape

# Retry only the documents that previously failed
npm run scrape -- --retry-failed

# Target the Poder Judicial site (run this on a Peru VPN)
npm run scrape -- --url "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml"
```

Or compile to JavaScript and run with Node:

```bash
npm run build
npm start -- --pages 2
```

### CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | OEFA TFA | Target results page |
| `--out <dir>` | `./output` | Output directory |
| `--pages <n>` | `0` (all) | Only scrape the first *n* pages |
| `--start-page <n>` | `0` | Start from 0-based page *n* |
| `--no-pdf` | off | Extract metadata only |
| `--max-pdf <n>` | `0` (all) | Stop after downloading *n* PDFs |
| `--page-delay <ms>` | `800` | Delay between page requests |
| `--pdf-delay <ms>` | `1200` | Delay between PDF downloads |
| `--max-retries <n>` | `5` | Max retry attempts on 429/transient errors |
| `--backoff-base <ms>` | `1000` | Base for exponential backoff |
| `--backoff-max <ms>` | `60000` | Cap for a single backoff wait |
| `--timeout <ms>` | `120000` | Per-request timeout |
| `--retry-failed` | off | Re-download only `failed-downloads.json` |
| `--help` | — | Show help |

Set `DEBUG=1` for verbose logging.

---

## Output

```
output/
├── data/
│   ├── documents.json          # full metadata + run summary
│   ├── documents.csv           # same data, Excel-friendly (UTF-8 BOM)
│   └── failed-downloads.json   # documents to retry (if any)
└── pdfs/
    ├── 000001__891-08-PRODUCE-DIGSECOVI-Dsvs__264-2012-OEFA-TFA__153a6d2a.pdf
    ├── 000002__857-2011-PRODUCE-DIGSECOVI-Dsvs__007-2016-OEFA-TFA-SEPIM__9c8d4d4a.pdf
    └── ...
```

`documents.json` shape:

```json
{
  "source": "https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml",
  "totalRecords": 1753,
  "extracted": 1753,
  "scrapedAt": "2026-06-24T09:19:04.616Z",
  "records": [
    {
      "nro": "1",
      "expediente": "891-08-PRODUCE/DIGSECOVI-Dsvs",
      "administrado": "Corporación del Mar S.A. Austral Group S.A.A.",
      "unidadFiscalizable": "Planta Playa Lado Norte Puerto Malabrigo",
      "sector": "Pesquería",
      "nroResolucion": "264-2012-OEFA/TFA",
      "uuid": "153a6d2a-cbed-40ef-b8ef-cd2272b19867",
      "page": 0,
      "globalIndex": 0
    }
  ]
}
```

> The `output/` directory is **git-ignored** — data and (large) PDFs are not
> committed.

---

## How 429 / rate-limiting is handled

All requests go through a single retry engine in
[`src/httpClient.ts`](src/httpClient.ts):

- On **429** (and `408` / `5xx` / network errors) it retries up to
  `--max-retries` times.
- Backoff is **exponential with full jitter**:
  `delay = random( base·2^attempt / 2 , base·2^attempt )`, capped at
  `--backoff-max`.
- If the server sends a **`Retry-After`** header (seconds or HTTP-date), that
  value is honored instead.
- When retries are exhausted for a PDF, the scraper **logs the document and moves
  on** — nothing aborts the whole run. Failures land in `failed-downloads.json`
  for a later `--retry-failed` pass.

---

## Project structure

```
src/
├── index.ts          # CLI entry point + orchestration (crawl → save → download)
├── config.ts         # defaults + tiny CLI flag parser
├── types.ts          # shared interfaces
├── logger.ts         # leveled, timestamped logger
├── httpClient.ts     # axios wrapper: cookies + 429/backoff retry engine
├── jsfClient.ts      # JSF/PrimeFaces protocol (session, search, paginate, PDF)
├── parser.ts         # cheerio parsing of HTML pages + AJAX partial-responses
├── pdfDownloader.ts  # per-document download (naming, skip, ViewExpired recovery)
└── storage.ts        # filesystem: dirs, filenames, JSON/CSV, failure log
```

---

## Notes & limitations

- Requests are **sequential and throttled** on purpose — this is a respectful
  scraper, not a load test. Tune `--page-delay` / `--pdf-delay` as needed.
- Dynamic JSF component ids (the `j_idtNN` filter inputs, the button, the table)
  are **read from the live markup**, so the scraper tolerates small redeploys.
- Per the challenge, you don't have to download all 1 753 PDFs in one run to
  submit — `--pages` / `--max-pdf` demonstrate it end-to-end, and a full run will
  complete the rest (resuming from what's already on disk).

## License

MIT
