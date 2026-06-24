/**
 * Entry point / orchestrator.
 *
 * Flow:
 *   1. Build config from CLI flags.
 *   2. Init JSF session and run the search to learn the total record count.
 *   3. Page through the whole result set, collecting metadata.
 *   4. Persist metadata as JSON + CSV.
 *   5. Download each document's PDF (unless --no-pdf), with 429 backoff and a
 *      failed-downloads log for later retry.
 *
 * `--retry-failed` skips crawling and only re-downloads the documents recorded
 * in failed-downloads.json.
 */
import * as path from "path";
import { buildConfig, HELP_TEXT } from "./config";
import { logger } from "./logger";
import { HttpClient, sleep } from "./httpClient";
import { JsfClient } from "./jsfClient";
import { PdfDownloader } from "./pdfDownloader";
import { DocumentRecord, DownloadResult, ScraperConfig } from "./types";
import {
  ensureDirs,
  readFailedLog,
  saveCsv,
  saveJson,
  writeFailedLog,
} from "./storage";

const log = logger.child("[main]");

/** Crawl every page and return the full, de-duplicated record list. */
async function crawlAllPages(
  jsf: JsfClient,
  config: ScraperConfig,
): Promise<{ records: DocumentRecord[]; totalRecords: number }> {
  const { records: firstPage, totalRecords } = await jsf.search();

  const session = jsf.getSession()!;
  const rowsPerPage = session.rowsPerPage || 10;
  const totalPages = Math.max(1, Math.ceil(totalRecords / rowsPerPage));

  const lastPage =
    config.maxPages > 0
      ? Math.min(totalPages, config.startPage + config.maxPages)
      : totalPages;

  log.info(
    `Total: ${totalRecords} records across ${totalPages} pages ` +
      `(${rowsPerPage}/page). Crawling pages ${config.startPage}..${lastPage - 1}.`,
  );

  const all: DocumentRecord[] = [];
  const seen = new Set<string>();

  const collect = (rows: DocumentRecord[]) => {
    for (const r of rows) {
      const key = r.uuid || `${r.page}:${r.globalIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
    }
  };

  // Page 0 was already fetched by search(); reuse it if we start there.
  if (config.startPage === 0) {
    collect(firstPage);
  }

  // If we started at page 0 it is already collected above, so begin at 1.
  const firstCrawlPage = config.startPage === 0 ? 1 : config.startPage;
  for (let page = firstCrawlPage; page < lastPage; page++) {
    await sleep(config.pageDelayMs);
    try {
      const rows = await jsf.gotoPage(page);
      collect(rows);
      if (page % 10 === 0 || page === lastPage - 1) {
        log.info(`  page ${page + 1}/${totalPages}: collected ${all.length} records so far`);
      }
      if (rows.length === 0) {
        log.warn(`  page ${page} returned 0 rows — stopping early.`);
        break;
      }
    } catch (err) {
      log.error(`  page ${page} failed: ${(err as Error).message}`);
      // Try to recover the session and continue.
      try {
        await jsf.refreshSession();
      } catch {
        log.error("  session refresh failed — aborting crawl.");
        break;
      }
    }
  }

  return { records: all, totalRecords };
}

/**
 * Download PDFs for a list of records.
 *
 * Records are processed grouped by their source page: before downloading a
 * page's rows, the DataTable is positioned on that page so the JSF command
 * links resolve (see {@link JsfClient.positionToPage}).
 */
async function downloadAll(
  jsf: JsfClient,
  downloader: PdfDownloader,
  records: DocumentRecord[],
  config: ScraperConfig,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  let done = 0;
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  const limit =
    config.maxPdf > 0 ? Math.min(config.maxPdf, records.length) : records.length;
  const targets = records.slice(0, limit);
  log.info(`Downloading PDFs for ${targets.length} document(s)...`);

  // Group by page, preserving page order.
  const byPage = new Map<number, DocumentRecord[]>();
  for (const r of targets) {
    const arr = byPage.get(r.page) ?? [];
    arr.push(r);
    byPage.set(r.page, arr);
  }
  const pages = Array.from(byPage.keys()).sort((a, b) => a - b);

  for (const page of pages) {
    const group = byPage.get(page)!;
    // Position the server-side DataTable on this page so row links resolve.
    try {
      await jsf.positionToPage(page);
    } catch (err) {
      log.warn(
        `Could not position on page ${page} (${(err as Error).message}); ` +
          `attempting full recovery.`,
      );
      try {
        await jsf.recoverToPage(page);
      } catch (err2) {
        log.error(`Recovery failed for page ${page}: ${(err2 as Error).message}`);
      }
    }

    for (let i = 0; i < group.length; i++) {
      const result = await downloader.download(group[i]);
      results.push(result);
      done++;
      if (result.status === "downloaded") downloaded++;
      else if (result.status === "skipped") skipped++;
      else failed++;

      if (done % 10 === 0 || done === targets.length) {
        log.info(
          `  progress ${done}/${targets.length} — ok:${downloaded} skip:${skipped} fail:${failed}`,
        );
      }

      // Be polite between downloads (skip the wait for cached files).
      if (result.status !== "skipped" && done < targets.length) {
        await sleep(config.pdfDelayMs);
      }
    }
  }

  return results;
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const config = buildConfig(argv);
  ensureDirs(config);

  log.info("OEFA / Poder Judicial JSF scraper starting");
  log.info(`Target : ${config.baseUrl}`);
  log.info(`Output : ${config.outputDir}`);

  const http = new HttpClient({
    timeoutMs: config.requestTimeoutMs,
    retry: {
      maxRetries: config.maxRetries,
      backoffBaseMs: config.backoffBaseMs,
      backoffMaxMs: config.backoffMaxMs,
    },
    logger,
  });
  const jsf = new JsfClient(http, config.baseUrl, logger);
  const downloader = new PdfDownloader(jsf, config, logger);

  await jsf.init();

  // --- Retry-failed mode: only re-download what previously failed. ---
  if (config.retryFailed) {
    const failedRecords = readFailedLog(config);
    if (failedRecords.length === 0) {
      log.info("No failed downloads recorded. Nothing to retry.");
      return;
    }
    log.info(`Retrying ${failedRecords.length} previously failed download(s).`);
    // A fresh ViewState is required for downloads.
    await jsf.search();
    const results = await downloadAll(jsf, downloader, failedRecords, config);
    const stillFailed = results.filter((r) => r.status === "failed");
    writeFailedLog(config, stillFailed);
    log.info(
      `Retry complete. Recovered ${results.filter((r) => r.status === "downloaded").length}, ` +
        `still failing ${stillFailed.length}.`,
    );
    return;
  }

  // --- Normal mode: crawl + (optionally) download. ---
  const { records, totalRecords } = await crawlAllPages(jsf, config);

  // Persist metadata.
  const jsonPath = path.join(config.dataDir, "documents.json");
  const csvPath = path.join(config.dataDir, "documents.csv");
  saveJson(jsonPath, {
    source: config.baseUrl,
    totalRecords,
    extracted: records.length,
    scrapedAt: new Date().toISOString(),
    records,
  });
  saveCsv(csvPath, records);
  log.info(`Saved metadata: ${records.length} records`);
  log.info(`  JSON: ${jsonPath}`);
  log.info(`  CSV : ${csvPath}`);

  if (config.skipPdf) {
    log.info("--no-pdf set: skipping PDF downloads. Done.");
    return;
  }

  const results = await downloadAll(jsf, downloader, records, config);

  const failures = results.filter((r) => r.status === "failed");
  writeFailedLog(config, failures);

  const downloaded = results.filter((r) => r.status === "downloaded").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  log.info("==================== SUMMARY ====================");
  log.info(`Records extracted : ${records.length} / ${totalRecords}`);
  log.info(`PDFs downloaded   : ${downloaded}`);
  log.info(`PDFs skipped      : ${skipped} (already present)`);
  log.info(`PDFs failed       : ${failures.length}`);
  if (failures.length > 0) {
    log.info(`Failed list saved to: ${path.join(config.dataDir, "failed-downloads.json")}`);
    log.info(`Retry later with: npm run scrape -- --retry-failed`);
  }
  log.info("=================================================");
}

main().catch((err) => {
  log.error("Fatal error:", err?.message || err);
  process.exitCode = 1;
});
