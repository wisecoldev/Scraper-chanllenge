/**
 * Default configuration and a tiny CLI flag parser.
 *
 * No external argument-parsing dependency is used — the challenge asks for a
 * lean axios + cheerio stack, so flags are parsed by hand.
 */
import * as path from "path";
import { ScraperConfig } from "./types";

/**
 * Target site.
 *
 * Default is the OEFA "Tribunal de Fiscalización Ambiental" repository, which is
 * reachable without a VPN. The Poder Judicial site has the same PrimeFaces/JSF
 * structure but is geo-restricted to Peru; point `--url` at it when on a Peru
 * VPN and the same code path applies.
 */
export const DEFAULT_BASE_URL =
  "https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "output");

/** Browser-like User-Agent; the sites reject the default axios UA. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function getFlag(args: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1] ?? "true";
    if (args[i].startsWith(eq)) return args[i].slice(eq.length);
  }
  return undefined;
}

function getBool(args: string[], name: string): boolean {
  const v = getFlag(args, name);
  return v === "true" || v === "" || v === "1";
}

function getInt(args: string[], name: string, fallback: number): number {
  const v = getFlag(args, name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Build the effective configuration from argv. */
export function buildConfig(argv: string[]): ScraperConfig {
  const args = argv.slice(2);

  const outputDir = getFlag(args, "out") ?? DEFAULT_OUTPUT_DIR;

  return {
    baseUrl: getFlag(args, "url") ?? DEFAULT_BASE_URL,
    outputDir,
    pdfDir: path.join(outputDir, "pdfs"),
    dataDir: path.join(outputDir, "data"),
    maxPages: getInt(args, "pages", 0),
    startPage: getInt(args, "start-page", 0),
    skipPdf: getBool(args, "no-pdf"),
    maxPdf: getInt(args, "max-pdf", 0),
    pageDelayMs: getInt(args, "page-delay", 800),
    pdfDelayMs: getInt(args, "pdf-delay", 1200),
    maxRetries: getInt(args, "max-retries", 5),
    backoffBaseMs: getInt(args, "backoff-base", 1000),
    backoffMaxMs: getInt(args, "backoff-max", 60000),
    retryFailed: getBool(args, "retry-failed"),
    requestTimeoutMs: getInt(args, "timeout", 120000),
  };
}

/** Human-readable help text printed with `--help`. */
export const HELP_TEXT = `
OEFA / Poder Judicial JSF scraper

Usage:
  npm run scrape -- [options]
  ts-node src/index.ts [options]

Options:
  --url <url>          Target results page (default: OEFA TFA repository)
  --out <dir>          Output directory (default: ./output)
  --pages <n>          Only scrape the first n pages (0 = all)
  --start-page <n>     Start from 0-based page n (default: 0)
  --no-pdf             Extract metadata only, do not download PDFs
  --max-pdf <n>        Stop after downloading n PDFs (0 = no limit)
  --page-delay <ms>    Delay between page requests (default: 800)
  --pdf-delay <ms>     Delay between PDF downloads (default: 1200)
  --max-retries <n>    Max retry attempts on 429/transient errors (default: 5)
  --backoff-base <ms>  Base for exponential backoff (default: 1000)
  --backoff-max <ms>   Max single backoff wait (default: 60000)
  --timeout <ms>       Per-request timeout (default: 120000)
  --retry-failed       Retry only the documents in failed-downloads.json
  --help               Show this help

Examples:
  # Smoke test: first 2 pages, metadata + PDFs
  npm run scrape -- --pages 2

  # Full metadata extraction, no PDFs
  npm run scrape -- --no-pdf

  # Full run
  npm run scrape

  # Retry previously failed downloads
  npm run scrape -- --retry-failed
`;
