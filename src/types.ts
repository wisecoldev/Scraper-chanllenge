/**
 * Shared type definitions for the scraper.
 */

/**
 * A single document row extracted from the results DataTable.
 *
 * The OEFA "Tribunal de Fiscalización Ambiental" table exposes these columns,
 * but the parser stores them generically so the same shape works if column
 * order changes slightly between deployments.
 */
export interface DocumentRecord {
  /** 1-based sequential number shown by the site ("Nro."). */
  nro: string;
  /** "Número de expediente". */
  expediente: string;
  /** "Administrado" (the regulated party). */
  administrado: string;
  /** "Unidad fiscalizable". */
  unidadFiscalizable: string;
  /** "Sector". */
  sector: string;
  /** "Nro. Resolución de Apelación". */
  nroResolucion: string;
  /**
   * UUID used as `param_uuid` to request the PDF. This is the stable
   * identifier for the document on the server.
   */
  uuid: string;
  /**
   * JSF client id of the download command link for this row
   * (e.g. `listarDetalleInfraccionRAAForm:dt:3:j_idt63`). Needed to build the
   * download POST.
   */
  downloadLinkId: string;
  /** 0-based page the row was found on. */
  page: number;
  /** Global 0-based index across the whole result set. */
  globalIndex: number;
}

/**
 * Result of attempting to download one PDF.
 */
export interface DownloadResult {
  record: DocumentRecord;
  status: "downloaded" | "skipped" | "failed";
  /** Absolute path of the saved file (when downloaded/skipped). */
  filePath?: string;
  /** Filename suggested by the server via Content-Disposition. */
  serverFilename?: string;
  /** Size in bytes (when downloaded). */
  bytes?: number;
  /** Number of attempts made. */
  attempts?: number;
  /** Error message (when failed). */
  error?: string;
}

/**
 * The mutable JSF view state of a live session: the action URL, the current
 * `javax.faces.ViewState` token and the static form fields that must be echoed
 * back on every postback.
 */
export interface JsfSession {
  /** Absolute action URL (already includes any `;jsessionid=` segment). */
  actionUrl: string;
  /** Current ViewState token; refreshed after every postback. */
  viewState: string;
  /** Form id (e.g. `listarDetalleInfraccionRAAForm`). */
  formId: string;
  /** DataTable client id (e.g. `listarDetalleInfraccionRAAForm:dt`). */
  dataTableId: string;
  /**
   * Client id of the element re-rendered by the search button (the `pgLista`
   * span that wraps the DataTable). Falls back to the DataTable id.
   */
  resultsContainerId: string;
  /** Search button client id (e.g. `listarDetalleInfraccionRAAForm:btnBuscar`). */
  searchButtonId: string;
  /** Rows rendered per page by the DataTable (usually 10). */
  rowsPerPage: number;
  /**
   * Static form fields (hidden inputs, selects, filter inputs) to echo on every
   * postback. Keys are the JSF names; values default to empty for filters.
   */
  formFields: Record<string, string>;
}

/** Runtime configuration assembled from defaults + CLI flags. */
export interface ScraperConfig {
  baseUrl: string;
  outputDir: string;
  pdfDir: string;
  dataDir: string;
  /** Only scrape the first N pages (0 = all). */
  maxPages: number;
  /** Start scraping from this 0-based page. */
  startPage: number;
  /** Skip downloading PDFs (metadata only). */
  skipPdf: boolean;
  /** Only download the first N PDFs across the run (0 = no limit). */
  maxPdf: number;
  /** Delay between list/page requests (ms). */
  pageDelayMs: number;
  /** Delay between PDF downloads (ms). */
  pdfDelayMs: number;
  /** Max retry attempts for a rate-limited / transient request. */
  maxRetries: number;
  /** Base backoff used for exponential backoff (ms). */
  backoffBaseMs: number;
  /** Cap for a single backoff wait (ms). */
  backoffMaxMs: number;
  /** Re-attempt only the documents listed in failed-downloads.json. */
  retryFailed: boolean;
  /** HTTP request timeout (ms). */
  requestTimeoutMs: number;
}
