/**
 * JSF / PrimeFaces protocol client for the OEFA / Poder Judicial repositories.
 *
 * Encapsulates the stateful conversation with the server:
 *   1. `init()`      — GET the page, bootstrap the session + ViewState.
 *   2. `search()`    — PrimeFaces AJAX postback on the "Buscar" button to load
 *                      the result set and learn the total record count.
 *   3. `gotoPage(n)` — PrimeFaces AJAX pagination postback for page n.
 *   4. `downloadPdf` — full (non-AJAX) form submit that streams back the PDF.
 *
 * The `javax.faces.ViewState` token is refreshed from every AJAX response and
 * reused for subsequent postbacks, mirroring how a browser drives the form.
 */
import { HttpClient } from "./httpClient";
import { Logger } from "./logger";
import { DocumentRecord, JsfSession } from "./types";
import {
  extractTableFragment,
  extractViewStateFromAjax,
  parseInitialPage,
  parseRows,
  parseTotalRecords,
} from "./parser";

/** A downloaded PDF together with the filename the server suggested. */
export interface PdfPayload {
  buffer: Buffer;
  serverFilename?: string;
  contentType?: string;
}

/** Raised when the server returns an HTML/JSF response where a PDF was expected
 *  (typically a `ViewExpired` or validation error). */
export class ViewExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewExpiredError";
  }
}

export class JsfClient {
  private session?: JsfSession;
  private readonly log: Logger;

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    logger: Logger,
  ) {
    this.log = logger.child("[jsf]");
  }

  private requireSession(): JsfSession {
    if (!this.session) {
      throw new Error("JSF session not initialised — call init() first.");
    }
    return this.session;
  }

  /** Header set PrimeFaces sends for AJAX postbacks. */
  private ajaxHeaders(): Record<string, string> {
    return {
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/xml, text/xml, */*; q=0.01",
      Referer: this.baseUrl,
    };
  }

  /** Build the static form fields (marker + filters + hidden inputs). */
  private baseParams(): URLSearchParams {
    const s = this.requireSession();
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(s.formFields)) params.append(k, v);
    return params;
  }

  /** GET the page and bootstrap the session. */
  async init(): Promise<JsfSession> {
    this.log.info(`Loading entry page: ${this.baseUrl}`);
    const res = await this.http.getText(this.baseUrl, "init");
    if (res.status !== 200) {
      throw new Error(
        `Entry page returned HTTP ${res.status}. ` +
          (res.status === 403
            ? "This site may be geo-restricted (VPN required)."
            : ""),
      );
    }
    this.session = parseInitialPage(res.data, this.baseUrl);
    this.log.info(
      `Session ready (form=${this.session.formId}, table=${this.session.dataTableId}, ` +
        `rows/page=${this.session.rowsPerPage}).`,
    );
    return this.session;
  }

  /**
   * Run the search (empty filters → full result set) and return the first page
   * of rows plus the total record count.
   */
  async search(): Promise<{ records: DocumentRecord[]; totalRecords: number }> {
    const s = this.requireSession();
    const params = this.baseParams();
    params.set("javax.faces.partial.ajax", "true");
    params.set("javax.faces.source", s.searchButtonId);
    params.set("javax.faces.partial.execute", "@all");
    params.set("javax.faces.partial.render", s.resultsContainerId);
    params.set(s.searchButtonId, s.searchButtonId);
    params.set("javax.faces.ViewState", s.viewState);

    const res = await this.http.postFormText(
      s.actionUrl,
      params.toString(),
      this.ajaxHeaders(),
      "search",
    );
    this.refreshViewState(res.data, "search");

    const total = parseTotalRecords(res.data) ?? 0;
    const fragment = extractTableFragment(res.data, s.dataTableId);
    const records = fragment ? parseRows(fragment, 0, s.rowsPerPage) : [];
    this.log.info(
      `Search OK: ${total} total records, ${records.length} on page 1.`,
    );
    return { records, totalRecords: total };
  }

  /**
   * Navigate to 0-based page `page` via a PrimeFaces pagination postback.
   * Returns the rows on that page.
   */
  async gotoPage(page: number): Promise<DocumentRecord[]> {
    const s = this.requireSession();
    const first = page * s.rowsPerPage;
    const dt = s.dataTableId;

    const params = this.baseParams();
    params.set("javax.faces.partial.ajax", "true");
    params.set("javax.faces.source", dt);
    params.set("javax.faces.partial.execute", dt);
    params.set("javax.faces.partial.render", dt);
    params.set(dt, dt);
    params.set(`${dt}_pagination`, "true");
    params.set(`${dt}_first`, String(first));
    params.set(`${dt}_rows`, String(s.rowsPerPage));
    params.set(`${dt}_skipChildren`, "true");
    params.set(`${dt}_encodeFeature`, "true");
    params.set("javax.faces.ViewState", s.viewState);

    const res = await this.http.postFormText(
      s.actionUrl,
      params.toString(),
      this.ajaxHeaders(),
      `page-${page}`,
    );
    this.refreshViewState(res.data, `page-${page}`);

    const fragment = extractTableFragment(res.data, dt);
    const records = fragment ? parseRows(fragment, page, s.rowsPerPage) : [];
    return records;
  }

  /**
   * Download a single document's PDF via a full form submit.
   * Throws {@link ViewExpiredError} if the server returns HTML instead of a PDF
   * (so the caller can re-establish the session and retry).
   */
  async downloadPdf(record: DocumentRecord): Promise<PdfPayload> {
    const s = this.requireSession();
    if (!record.uuid || !record.downloadLinkId) {
      throw new Error(
        `Record ${record.expediente} has no PDF link (uuid/linkId missing).`,
      );
    }

    const params = this.baseParams();
    params.set(record.downloadLinkId, record.downloadLinkId);
    params.set("param_uuid", record.uuid);
    params.set("javax.faces.ViewState", s.viewState);

    const res = await this.http.postFormBinary(
      s.actionUrl,
      params.toString(),
      `pdf:${record.uuid}`,
    );

    if (res.status !== 200) {
      throw new Error(`PDF request returned HTTP ${res.status}`);
    }

    const buffer = Buffer.from(res.data);
    const contentType = String(res.headers["content-type"] || "");

    // A real PDF starts with "%PDF". If we got HTML/XML, the JSF view likely
    // expired — signal the caller to refresh and retry.
    const looksPdf =
      buffer.slice(0, 5).toString("latin1").startsWith("%PDF") ||
      /pdf|octet-stream/i.test(contentType);
    if (!looksPdf) {
      const head = buffer.slice(0, 200).toString("latin1");
      throw new ViewExpiredError(
        `Expected PDF but got "${contentType}" (head: ${head.slice(0, 80)}...)`,
      );
    }

    return {
      buffer,
      serverFilename: this.filenameFromHeaders(res.headers),
      contentType,
    };
  }

  /** Re-run init()+search() to obtain a fresh ViewState after expiry. */
  async refreshSession(): Promise<void> {
    this.log.warn("Refreshing JSF session (ViewState expired).");
    await this.init();
    await this.search();
  }

  /**
   * Position the DataTable on the server so the command links for `page`'s rows
   * are resolvable, then leave a fresh ViewState in place.
   *
   * The PDF download is a full form submit that references a row's client id
   * (which embeds its index). JSF can only decode that link when the table's
   * server-side current page matches the row — so we must navigate there first.
   */
  async positionToPage(page: number): Promise<void> {
    const s = this.requireSession();
    await this.gotoPage(page);
    this.log.debug(`Positioned DataTable on page ${page} (first=${page * s.rowsPerPage}).`);
  }

  /**
   * Recover after a ViewExpired during download: rebuild the session from
   * scratch and re-position on the row's page.
   */
  async recoverToPage(page: number): Promise<void> {
    await this.init();
    await this.search();
    if (page > 0) await this.gotoPage(page);
  }

  /** Update the stored ViewState from an AJAX response. */
  private refreshViewState(xml: string, label: string): void {
    const vs = extractViewStateFromAjax(xml);
    if (vs && this.session) {
      this.session.viewState = vs;
    } else {
      this.log.debug(`No ViewState in ${label} response (keeping previous).`);
    }
  }

  /** Parse Content-Disposition for the suggested filename. */
  private filenameFromHeaders(
    headers: Record<string, unknown>,
  ): string | undefined {
    const cd = String(headers["content-disposition"] || "");
    if (!cd) return undefined;
    // filename*=UTF-8''... or filename="..."
    const star = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        return star[1].trim();
      }
    }
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    return plain ? plain[1].trim() : undefined;
  }

  getSession(): JsfSession | undefined {
    return this.session;
  }
}
