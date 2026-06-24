/**
 * HTML / JSF partial-response parsing built on cheerio.
 *
 * Two kinds of payload are parsed here:
 *  1. The initial full HTML page (GET) — to bootstrap the JSF session
 *     (form id, ViewState, DataTable id, search button id, form fields).
 *  2. PrimeFaces AJAX `partial-response` XML — to pull the refreshed ViewState,
 *     the total record count and the table rows after search/pagination.
 */
import * as cheerio from "cheerio";
import { DocumentRecord, JsfSession } from "./types";

/** Strip the `;jsessionid=...` path segment from a URL (we carry the cookie). */
export function stripJsessionId(url: string): string {
  return url.replace(/;jsessionid=[^?#]*/i, "");
}

/**
 * Extract the CDATA payload of the `<update>` element whose id matches `test`.
 * Returns undefined when not present.
 */
export function extractUpdateCData(
  xml: string,
  test: (id: string) => boolean,
): string | undefined {
  const re = /<update id="([^"]+)"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (test(m[1])) return m[2];
  }
  return undefined;
}

/** Pull the refreshed ViewState token out of an AJAX partial-response. */
export function extractViewStateFromAjax(xml: string): string | undefined {
  return extractUpdateCData(xml, (id) => id.includes("javax.faces.ViewState"));
}

/** Pull the ViewState token out of a full HTML page. */
export function extractViewStateFromHtml(html: string): string | undefined {
  const $ = cheerio.load(html);
  const v = $('input[name="javax.faces.ViewState"]').attr("value");
  return v || undefined;
}

/**
 * Parse the total record count. The site renders e.g.
 * "Página 1 de 176 (1753 registros)" and the DataTable widget config carries
 * `rowCount:1753`. We try both.
 */
export function parseTotalRecords(payload: string): number | undefined {
  const reg = payload.match(/\((\d+)\s+registros\)/i);
  if (reg) return parseInt(reg[1], 10);
  const rc = payload.match(/rowCount:(\d+)/);
  if (rc) return parseInt(rc[1], 10);
  return undefined;
}

/**
 * Bootstrap a JSF session from the initial full HTML page.
 * Dynamic JSF ids (the `j_idtNN` filter inputs, the button, the table) are read
 * from the markup so the scraper survives small redeploys.
 */
export function parseInitialPage(html: string, pageUrl: string): JsfSession {
  const $ = cheerio.load(html);

  // The main form is the one that contains the ViewState input.
  const viewStateInput = $('input[name="javax.faces.ViewState"]').first();
  const form = viewStateInput.closest("form");
  if (form.length === 0) {
    throw new Error("Could not locate the JSF form on the page.");
  }

  const formId = form.attr("id");
  if (!formId) throw new Error("JSF form has no id.");

  const viewState = viewStateInput.attr("value");
  if (!viewState) throw new Error("Could not read javax.faces.ViewState.");

  // Action URL: prefer the form's action, fall back to the page URL.
  const rawAction = form.attr("action") || pageUrl;
  const actionUrl = stripJsessionId(new URL(rawAction, pageUrl).toString());

  // DataTable id + rows-per-page from the PrimeFaces widget bootstrap script.
  const scripts = $("script")
    .map((_, el) => $(el).html() || "")
    .get()
    .join("\n");
  const dtMatch = scripts.match(
    /PrimeFaces\.cw\("DataTable","[^"]+",\{id:"([^"]+)"/,
  );
  const dataTableId = dtMatch ? dtMatch[1] : `${formId}:dt`;
  const rowsMatch = scripts.match(/paginator:\{[^}]*rows:(\d+)/);
  const rowsPerPage = rowsMatch ? parseInt(rowsMatch[1], 10) : 10;

  // Results container re-rendered by the search button (the `pgLista` span).
  const container = $('[id$=":pgLista"]').first().attr("id");
  const resultsContainerId = container || dataTableId;

  // Search button: a submit button inside the form (PrimeFaces CommandButton).
  let searchButtonId = "";
  form.find("button[id], input[type=submit][name]").each((_, el) => {
    const $el = $(el);
    const cls = $el.attr("class") || "";
    const id = $el.attr("id") || $el.attr("name") || "";
    if (!id) return;
    if (!searchButtonId) searchButtonId = id; // first candidate
    if (/buscar/i.test(cls) || /btnBuscar/i.test(id)) searchButtonId = id;
  });
  if (!searchButtonId) searchButtonId = `${formId}:btnBuscar`;

  // Static form fields to echo on every postback: every named input/select
  // except the ViewState and submit buttons. Filters keep their (empty) value.
  const formFields: Record<string, string> = {};
  form.find("input[name], select[name]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    if (name === "javax.faces.ViewState") return;
    const type = ($el.attr("type") || "").toLowerCase();
    if (type === "submit" || type === "button") return;
    // For selects, default to the currently-selected option or empty.
    if (el.tagName?.toLowerCase() === "select") {
      const selected = $el.find("option[selected]").attr("value");
      formFields[name] = selected ?? "";
    } else {
      formFields[name] = $el.attr("value") ?? "";
    }
  });

  return {
    actionUrl,
    viewState,
    formId,
    dataTableId,
    resultsContainerId,
    searchButtonId,
    rowsPerPage,
    formFields,
  };
}

/**
 * Parse document rows out of a fragment of table HTML (the CDATA payload of an
 * AJAX update, or a slice of the full page).
 *
 * Column order on the OEFA TFA table:
 *   Nro | Expediente | Administrado | Unidad fiscalizable | Sector |
 *   Nro. Resolución | Archivo(PDF link)
 */
export function parseRows(
  fragmentHtml: string,
  page: number,
  rowsPerPage: number,
): DocumentRecord[] {
  // PrimeFaces pagination updates return *bare* <tr> rows with no surrounding
  // <table>. The HTML parser drops table-row elements that lack a table
  // ancestor, so wrap such fragments to give them a valid table context.
  const html = /<table[\s>]/i.test(fragmentHtml)
    ? fragmentHtml
    : `<table><tbody>${fragmentHtml}</tbody></table>`;
  const $ = cheerio.load(html);
  const records: DocumentRecord[] = [];

  $("tr[data-ri]").each((_, tr) => {
    const $tr = $(tr);
    const dataRi = parseInt($tr.attr("data-ri") || "-1", 10);
    const cells = $tr
      .find("td")
      .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();

    // Download link: parse the mojarra.jsfcljs onclick for link id + uuid.
    const onclick = $tr.find("a[onclick]").attr("onclick") || "";
    const uuidMatch = onclick.match(/param_uuid'\s*:\s*'([0-9a-fA-F-]{36})'/);
    const linkIdMatch = onclick.match(
      /document\.getElementById\('[^']+'\)\s*,\s*\{\s*'([^']+)'\s*:/,
    );

    const uuid = uuidMatch ? uuidMatch[1] : "";
    const downloadLinkId = linkIdMatch ? linkIdMatch[1] : "";

    const globalIndex =
      dataRi >= 0 ? dataRi : page * rowsPerPage + records.length;

    records.push({
      nro: cells[0] ?? String(globalIndex + 1),
      expediente: cells[1] ?? "",
      administrado: cells[2] ?? "",
      unidadFiscalizable: cells[3] ?? "",
      sector: cells[4] ?? "",
      nroResolucion: cells[5] ?? "",
      uuid,
      downloadLinkId,
      page,
      globalIndex,
    });
  });

  return records;
}

/**
 * Given an AJAX partial-response, return the HTML fragment that contains the
 * table rows (the update for the DataTable or its wrapper).
 */
export function extractTableFragment(
  xml: string,
  dataTableId: string,
): string | undefined {
  // Prefer the most specific update (the datatable), then any update that
  // actually contains rows.
  const direct = extractUpdateCData(xml, (id) => id === dataTableId);
  if (direct && /data-ri=/.test(direct)) return direct;

  const wrapper = extractUpdateCData(
    xml,
    (id) => id.endsWith(":pgLista") || id.includes(dataTableId),
  );
  if (wrapper && /data-ri=/.test(wrapper)) return wrapper;

  // Fallback: scan every update for one that contains rows.
  const re = /<update id="[^"]+"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (/data-ri=/.test(m[1])) return m[1];
  }
  return undefined;
}
