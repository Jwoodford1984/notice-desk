// GENERATED from supabase/functions/_shared/parsers.mts with esbuild (types stripped) so the browser can use the same DACS parsers.
// Regenerate: npx esbuild supabase/functions/_shared/parsers.mts --format=esm --outfile=assets/dacs-parsers.js
function parseCSV(text) {
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}
function decode(buf) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buf), encoding: "Windows-1252" };
  }
}
const clean = (v) => String(v ?? "").trim().replace(/;+$/, "").trim();
const isBlank = (r) => r.every((c) => c === "");
function parseSource(text, encoding) {
  const raw = parseCSV(text);
  if (raw.some((r) => clean(r[0]) === "SiteName" && clean(r[1]) === "VService")) return parseDacs(raw, encoding);
  return parseBpipeUsage(raw, encoding);
}
function parseDacs(raw, encoding) {
  const warnings = [];
  let semis = 0;
  const rows = raw.map((r) => r.map((c) => {
    if (/;\s*$/.test(c)) semis++;
    return clean(c);
  }));
  const meta = { report: rows[0]?.[0] ?? "", version: "", generated: "", period: "" };
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === "Version" && !meta.version) meta.version = rows[i][1] ?? "";
    if (rows[i][0] === "GenerateDate" && !meta.generated) {
      meta.generated = rows[i + 1]?.[0] ?? "";
      if (rows[i][1] === "ReqStartDate") meta.period = `${rows[i + 1]?.[1] ?? ""} \u2013 ${rows[i + 1]?.[2] ?? ""}`;
    }
  }
  const hi = rows.findIndex((r) => r[0] === "SiteName" && r[1] === "VService");
  if (hi < 0) throw new Error("Couldn't find the user table (a header row starting SiteName, VService).");
  const H = rows[hi];
  const col = (n) => H.indexOf(n);
  const isUsage = col("Item") >= 0;
  const isPerms = !isUsage && col("FeeStructure") >= 0;
  if (!isUsage && !isPerms) throw new Error("Unsupported DACS report. Use Usage Detail by User or Active Permission by Exchange.");
  const usage = [], perms = [];
  let blankPos = 0, dup = 0, noEmail = 0;
  const seen = /* @__PURE__ */ new Set();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlank(r)) break;
    const g = (n) => col(n) >= 0 ? r[col(n)] ?? "" : "";
    if (isUsage) {
      const o = {
        login: g("Login"),
        user_name: g("UName"),
        user_group: g("UGroup"),
        cost_centre: g("UCostCtr"),
        email: g("Email"),
        service_code: g("Global_Name"),
        service_desc: g("Description"),
        item: g("Item")
      };
      if (!o.item || !o.login) continue;
      if (!g("UAccessPos")) blankPos++;
      if (!o.email) noEmail++;
      const k = o.login + "|" + o.item;
      if (seen.has(k)) dup++;
      seen.add(k);
      usage.push(o);
    } else {
      const o = {
        login: g("Login"),
        user_name: g("UName"),
        email: g("Email"),
        service_code: g("Global_Name"),
        service_desc: g("Description"),
        fee_structure: g("FeeStructure"),
        activated_label: g("Activation")
      };
      if (!o.login || !o.service_code) continue;
      if (!o.email) noEmail++;
      perms.push(o);
    }
  }
  const siteServices = [];
  const mi = rows.findIndex((r) => r[0] === "mapsite");
  if (mi >= 0) for (let j = mi + 1; j < rows.length && !isBlank(rows[j]); j++) {
    const r = rows[j];
    siteServices.push({ site_name: r[0], service_code: r[2], service_desc: r[3], fee_structure: r[4] });
  }
  const repeats = rows.filter((r) => r[0] === meta.report).length - 1;
  if (encoding !== "UTF-8") warnings.push(`File is ${encoding}-encoded, not UTF-8; read with the correct encoding.`);
  if (semis) warnings.push(`Removed ${semis} trailing semicolons from cells.`);
  if (repeats > 0) warnings.push(`Ignored ${repeats} repeated report header block(s).`);
  if (isUsage) {
    if (blankPos) warnings.push(`${blankPos} usage row(s) have a blank UAccessPos.`);
    if (dup) warnings.push(`${dup} duplicate login + RIC row(s).`);
    if (noEmail) warnings.push(`${noEmail} of ${usage.length} rows have no email; emails come from the permission file where logins match.`);
    return { kind: "lseg_usage", rows: usage, meta, warnings };
  }
  if (noEmail) warnings.push(`${noEmail} permission row(s) have no email address.`);
  const descs = /* @__PURE__ */ new Map();
  perms.forEach((p) => {
    if (!descs.has(p.service_code)) descs.set(p.service_code, /* @__PURE__ */ new Set());
    descs.get(p.service_code).add(p.service_desc.toUpperCase());
  });
  const incons = [...descs].filter(([, s]) => s.size > 1).map(([g]) => g);
  if (incons.length) warnings.push(`Services with more than one description: ${incons.join(", ")}. Matching uses Global_Name.`);
  const noFee = perms.filter((p) => !p.fee_structure).length;
  if (noFee) warnings.push(`${noFee} row(s) have a blank FeeStructure.`);
  return { kind: "lseg_permissions", rows: perms, siteServices, meta, warnings };
}
const BPIPE_COLS = {
  login: /^(user ?id|uuid|login|emrs ?user|user|bpipe ?user|application ?name)$/i,
  user_name: /^(user ?name|name|full ?name|display ?name)$/i,
  cost_centre: /^(cost ?cent(re|er)|cost ?ctr|cc)$/i,
  email: /^(e-?mail|email ?address)$/i,
  item: /^(security|ticker|instrument|identifier|security ?name|bbg ?ticker)$/i,
  service_code: /^(exchange( ?code)?|eid|service|entitlement|exch)$/i
};
function parseBpipeUsage(raw, encoding) {
  const rows = raw.map((r) => r.map(clean));
  const hi = rows.slice(0, 30).findIndex((r) => r.some((c) => BPIPE_COLS.item.test(c)) && r.some((c) => BPIPE_COLS.login.test(c)));
  if (hi < 0) throw new Error('Not a recognised file. Expected a DACS export, or a B-PIPE usage CSV with a user column (e.g. "User ID") and a security column (e.g. "Security").');
  const H = rows[hi];
  const idx = Object.fromEntries(Object.entries(BPIPE_COLS).map(([k, re]) => [k, H.findIndex((h) => re.test(h))]));
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlank(r)) continue;
    const g = (k) => idx[k] >= 0 ? r[idx[k]] ?? "" : "";
    const o = {
      login: g("login"),
      user_name: g("user_name"),
      user_group: "",
      cost_centre: g("cost_centre"),
      email: g("email"),
      service_code: g("service_code"),
      service_desc: "",
      item: g("item")
    };
    if (o.login && o.item) out.push(o);
  }
  const warnings = [];
  if (encoding !== "UTF-8") warnings.push(`File is ${encoding}-encoded, not UTF-8.`);
  const missing = ["user_name", "cost_centre", "email", "service_code"].filter((k) => idx[k] < 0);
  if (missing.length) warnings.push(`Optional columns not found: ${missing.join(", ")}.`);
  return { kind: "bpipe_usage", rows: out, meta: { report: "B-PIPE usage", version: "", generated: "", period: "" }, warnings };
}
function parseNoticeSheet(aoa) {
  const warnings = [];
  const isHdr = (r) => r.some((c) => /\b(ric|ticker|instrument|symbol|identifier|security)s?\b/i.test(String(c)));
  let hi = aoa.slice(0, 20).findIndex(isHdr);
  let H;
  if (hi < 0) {
    hi = -1;
    H = (aoa[0] ?? []).map((_, i) => `Column ${i + 1}`);
    warnings.push("No header row found; using the first column as the instrument.");
  } else H = aoa[hi].map((c) => String(c).trim());
  const find = (re, not) => H.findIndex((h) => re.test(h) && !(not && not.test(h)));
  let instrument = find(/(old|current|existing|from).*(ric|ticker|security)|^(ric|ticker|instrument|symbol|security)s?$/i);
  if (instrument < 0) instrument = find(/ric|ticker|instrument|symbol|security/i, /new/i);
  if (instrument < 0) instrument = 0;
  const new_code = find(/new.*(ric|ticker|security)|(ric|ticker).*new|^to$/i);
  const change = find(/change|action|event|type/i);
  const effective = find(/effective|date/i);
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const v = String(r[instrument] ?? "").trim();
    if (!v) continue;
    let e = effective >= 0 ? r[effective] : "";
    if (e instanceof Date) e = e.toISOString().slice(0, 10);
    rows.push({
      current_code: v,
      new_code: new_code >= 0 ? String(r[new_code] ?? "").trim() : "",
      change_type: change >= 0 ? String(r[change] ?? "").trim() : "",
      effective_label: String(e ?? "")
    });
  }
  if (!rows.length) warnings.push("No instrument rows found.");
  return { header: H, columns: { instrument, new_code, change, effective }, rows, warnings };
}
const SUMMARY_COLS = {
  notification_id: /^notification id$/i,
  title: /^title$/i,
  change_type: /^change type$/i,
  effective_from: /^effective from$/i,
  effective_to: /^effective to$/i,
  summary: /^summary$/i,
  description: /^description$/i,
  published_date: /^version published date$/i,
  revision_reason: /^revision reason$/i,
  affected_band: /^number of affected instruments$/i,
  old_pdp: /^old service package/i,
  new_pdp: /^new service package/i,
  old_price: /^old price$/i,
  new_price: /^new price$/i,
  old_pe: /^old resource group/i,
  new_pe: /^new resource group/i,
  status: /^status$/i,
  version: /^version$/i,
  associated_ids: /^associated notification/i,
  associated_products: /^associated products$/i,
  content_set: /^content set$/i,
  related_links: /^related links$/i
};
function toIsoDate(v) {
  if (v === null || v === void 0 || v === "") return "";
  if (v instanceof Date) {
    const d = new Date(v.getTime() + 12 * 3600 * 1e3);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1e3));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}
function isChangeSummary(aoa) {
  return aoa.slice(0, 10).some((r) => r.some((c) => /^notification id$/i.test(String(c).trim())));
}
function parseChangeSummary(aoa) {
  const hi = aoa.slice(0, 10).findIndex((r) => r.some((c) => /^notification id$/i.test(String(c).trim())));
  if (hi < 0) throw new Error('Not a Quarterly Change Summary: no "Notification ID" column found.');
  const H = aoa[hi].map((c) => String(c).trim());
  const idx = Object.fromEntries(Object.entries(SUMMARY_COLS).map(([k, re]) => [k, H.findIndex((h) => re.test(h))]));
  const dates = /* @__PURE__ */ new Set(["effective_from", "effective_to", "published_date"]);
  const rows = [];
  let badDates = 0;
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const id = String(r[idx.notification_id] ?? "").trim();
    if (!id) continue;
    const o = {};
    for (const k of Object.keys(SUMMARY_COLS)) {
      const v = idx[k] >= 0 ? r[idx[k]] : "";
      if (dates.has(k)) {
        o[k] = toIsoDate(v);
        if (v !== "" && v != null && !o[k]) badDates++;
      } else o[k] = String(v ?? "").replace(/ /g, " ").trim();
    }
    o.affected_band = o.affected_band.replace(/^'+|'+$/g, "");
    o.notification_id = id;
    rows.push(o);
  }
  const warnings = [];
  const missing = Object.keys(SUMMARY_COLS).filter((k) => idx[k] < 0);
  if (missing.length) warnings.push(`Columns not found: ${missing.join(", ")}.`);
  if (badDates) warnings.push(`${badDates} date cell(s) could not be read.`);
  const notices = new Set(rows.map((r) => r.notification_id)).size;
  return { rows, notices, warnings };
}
export {
  decode,
  isChangeSummary,
  parseBpipeUsage,
  parseCSV,
  parseChangeSummary,
  parseDacs,
  parseNoticeSheet,
  parseSource,
  toIsoDate
};
