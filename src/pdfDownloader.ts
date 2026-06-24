/**
 * PDF download orchestration for a single document.
 *
 * Layered retry strategy:
 *   - Transport-level 429 / 5xx / network retries with exponential backoff are
 *     handled inside {@link HttpClient}.
 *   - This module adds a *session-level* recovery: if the server returns HTML
 *     instead of a PDF (a JSF `ViewExpired`), it refreshes the session once and
 *     retries the download.
 *   - Already-downloaded files are skipped so runs are resumable.
 */
import * as path from "path";
import { JsfClient, ViewExpiredError } from "./jsfClient";
import { Logger } from "./logger";
import { sleep } from "./httpClient";
import { DocumentRecord, DownloadResult, ScraperConfig } from "./types";
import {
  buildPdfFilename,
  fileExistsNonEmpty,
  writeBufferAtomic,
} from "./storage";

export class PdfDownloader {
  private readonly log: Logger;

  constructor(
    private readonly jsf: JsfClient,
    private readonly config: ScraperConfig,
    logger: Logger,
  ) {
    this.log = logger.child("[pdf]");
  }

  /**
   * Download one document's PDF. Never throws — always resolves to a
   * {@link DownloadResult} so the caller can keep going and log failures.
   */
  async download(record: DocumentRecord): Promise<DownloadResult> {
    const filename = buildPdfFilename(record);
    const filePath = path.join(this.config.pdfDir, filename);

    // Resumability: skip files we already have.
    if (fileExistsNonEmpty(filePath)) {
      this.log.debug(`Skip (exists): ${filename}`);
      return { record, status: "skipped", filePath };
    }

    if (!record.uuid || !record.downloadLinkId) {
      const error = "Missing PDF link (uuid/linkId)";
      this.log.warn(`No PDF for expediente "${record.expediente}": ${error}`);
      return { record, status: "failed", error, attempts: 0 };
    }

    // Allow one session refresh on a ViewExpired before giving up.
    const maxSessionRetries = 1;
    let attempts = 0;

    for (let sessionTry = 0; sessionTry <= maxSessionRetries; sessionTry++) {
      attempts++;
      try {
        const payload = await this.jsf.downloadPdf(record);
        writeBufferAtomic(filePath, payload.buffer);
        this.log.info(
          `Saved ${filename} (${(payload.buffer.length / 1024).toFixed(0)} KB)` +
            (payload.serverFilename ? ` [server: ${payload.serverFilename}]` : ""),
        );
        return {
          record,
          status: "downloaded",
          filePath,
          serverFilename: payload.serverFilename,
          bytes: payload.buffer.length,
          attempts,
        };
      } catch (err) {
        if (err instanceof ViewExpiredError && sessionTry < maxSessionRetries) {
          this.log.warn(
            `ViewExpired downloading "${record.expediente}"; ` +
              `rebuilding session and re-positioning on page ${record.page}.`,
          );
          try {
            await this.jsf.recoverToPage(record.page);
            await sleep(this.config.pdfDelayMs);
          } catch (refreshErr) {
            return {
              record,
              status: "failed",
              error: `Session recovery failed: ${(refreshErr as Error).message}`,
              attempts,
            };
          }
          continue;
        }
        const error = (err as Error).message || String(err);
        this.log.error(
          `Failed PDF for "${record.expediente}" (uuid ${record.uuid}): ${error}`,
        );
        return { record, status: "failed", error, attempts };
      }
    }

    return {
      record,
      status: "failed",
      error: "Exhausted session retries",
      attempts,
    };
  }
}
