// Impact engine: turns a client's DACS files plus library matches into a list
// of affected users, notices and actions. Pure functions, no network or DOM,
// so the browser and the tests run exactly the same logic.

const isProductCode = c => /^WW/i.test(c); // LSEG Workspace product codes, not exchange PDPs
export const splitCodes = s => String(s || '').replace(/ /g, ' ').split(/[\s,;]+/).map(c => c.trim()).filter(Boolean);
const pdpSet = s => new Set(splitCodes(s).filter(c => !isProductCode(c)));
const uniq = a => [...new Set(a)];

export const isBpipeRow = r => /^BPIPE$/i.test(String(r.v_service || ''));
/** DACS B-PIPE items look like "kyRRN10M_BGSS_Curncy": drop the "ky" prefix, underscores are spaces. */
export const bpipeDisplay = item => String(item || '').trim().replace(/^ky(?=[A-Z0-9.])/, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
export const bpipeTicker = item => bpipeDisplay(item).toUpperCase();
/** Bloomberg EID of a DACS B-PIPE row: leading digits of Description ("33828 Bloomberg BGN …") or Global_Name ("74835_Cantor…"). */
export const eidOf = r => (String(r.service_desc || '').match(/^(\d{3,})\b/) || String(r.service_code || '').match(/^(\d{3,})_/) || [])[1] || '';

/** Codes to send for matching, per vendor: LSEG RICs (plus chain bases) and Bloomberg tickers. */
export function vendorUsageCodes(usage) {
  return { LSEG: [...usageCodes(usage.filter(u => !isBpipeRow(u))).keys()], Bloomberg: [...usageCodes(usage.filter(isBpipeRow), 'Bloomberg').keys()] };
}

/** Codes to send for matching: each usage item normalised, plus the base of chain RICs. */
export function usageCodes(usage, vendor = 'LSEG') {
  const map = new Map(); // code sent -> [{ row, via }]
  for (const u of usage) {
    if (vendor === 'Bloomberg') {
      const t = bpipeTicker(u.item); if (!t) continue;
      if (!map.has(t)) map.set(t, []); map.get(t).push({ row: u, via: 'direct' }); continue;
    }
    const norm = String(u.item || '').trim().replace(/^\//, '');
    if (!norm) continue;
    const add = (code, via) => { if (!map.has(code)) map.set(code, []); map.get(code).push({ row: u, via }); };
    add(norm, 'direct');
    const m = norm.match(/^\d#(.+)$/); if (m) add(m[1], 'chain');
  }
  return map;
}

export const SEVERITY = {
  'Update RIC': 1, 'RIC removed': 1, 'Order service': 1, 'Content withdrawn': 1, 'Update tickers': 1,
  'Check entitlement': 2, 'Review data change': 2, 'Price change': 2, 'Review policy': 2, 'Review notice': 2,
  'Information': 3,
};

function dueText(effective, today) {
  if (!effective) return { due: null, label: 'No date' };
  const eff = new Date(effective + 'T00:00:00'); const t = new Date(today + 'T00:00:00');
  const due = new Date(eff.getTime() - 5 * 86400000);
  if (eff <= t) return { due: today, label: 'Already effective: act now' };
  if (due <= t) return { due: today, label: 'Due now' };
  return { due: due.toISOString().slice(0, 10), label: '' };
}

/**
 * @param {object} input
 * @param {object[]} input.usage        DACS usage rows (may be empty)
 * @param {object[]} input.perms        DACS permission rows (may be empty)
 * @param {object[]} input.notices      library notices {id, ref, vendor, title, change_types, effective_date, summary}
 * @param {object[]} input.changes      library service changes {notice_id, old_pdp, new_pdp, old_pe, new_pe, old_price, new_price}
 * @param {object[]} input.matches      lib_match_codes rows for the usage codes
 * @param {string}   input.today        YYYY-MM-DD
 */
const money = (v, cur) => `${cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : (cur ? cur + ' ' : '')}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parsePrice = s => { const m = String(s || '').match(/(-?[\d.,]+)\s*([A-Z]{3})?/); return m ? { v: parseFloat(m[1].replace(/,/g, '')), cur: m[2] || '' } : null; };

export function buildReport({ usage = [], perms = [], notices = [], changes = [], matches = [], bbgMatches = [], prices = [], today }) {
  const priceOf = new Map(prices.filter(p => p.vendor !== 'Bloomberg').map(p => [p.pdp, p]));
  const noticeById = new Map(notices.map(n => [n.id, n]));
  const cancelled = n => /cancel/i.test(n.vendor_status || '');
  // DACS can carry Bloomberg B-PIPE services (VService BPIPE) alongside LSEG (IDN)
  const lsegUsage = usage.filter(u => !isBpipeRow(u)), bbgUsage = usage.filter(isBpipeRow);
  const lsegPerms = perms.filter(p => !isBpipeRow(p)), bbgPerms = perms.filter(isBpipeRow);
  const permsBy = new Map();
  for (const p of lsegPerms) { if (!permsBy.has(p.login)) permsBy.set(p.login, new Set()); permsBy.get(p.login).add(p.service_code); }
  const hasPerms = lsegPerms.length > 0;
  // Bloomberg: EIDs held (permissions) and tickers requested per EID (usage)
  const eidsBy = new Map(), tickersBy = new Map();
  for (const p of bbgPerms) { const e = eidOf(p); if (!e) continue; if (!eidsBy.has(p.login)) eidsBy.set(p.login, new Set()); eidsBy.get(p.login).add(e); }
  for (const u of bbgUsage) {
    const e = eidOf(u); if (!e) continue;
    if (!tickersBy.has(u.login)) tickersBy.set(u.login, new Map());
    const m = tickersBy.get(u.login); if (!m.has(e)) m.set(e, new Set()); m.get(e).add(bpipeDisplay(u.item));
  }

  // People and applications on the site
  const people = new Map();
  const person = login => {
    if (!people.has(login)) people.set(login, { login, name: '', cost_centre: '', email: '', group: '' });
    return people.get(login);
  };
  for (const p of perms) { const x = person(p.login); x.name ||= p.user_name; x.email ||= p.email; }
  for (const u of usage) { const x = person(u.login); x.name ||= u.user_name; x.cost_centre ||= u.cost_centre; x.email ||= u.email; x.group ||= u.user_group; }

  const actions = new Map(); // key -> action
  const addAction = (n, category, text, login, ric, extra = {}) => {
    const key = `${n.id}|${category}|${extra.groupKey || text}`;
    if (!actions.has(key)) {
      const d = dueText(n.effective_date, today);
      actions.set(key, { notice_id: n.id, ref: n.ref, vendor: n.vendor, title: n.title, effective_date: n.effective_date, due_date: d.due, due_label: d.label,
        category, severity: SEVERITY[category] || 3, text, users: new Set(), rics: new Set(), ...extra });
      delete actions.get(key).groupKey;
    }
    const a = actions.get(key);
    if (login) a.users.add(login);
    if (ric) a.rics.add(ric);
  };

  // ---- RIC level: library rows whose code appears in usage
  const codeMap = usageCodes(lsegUsage);
  const bbgCodeMap = usageCodes(bbgUsage, 'Bloomberg');
  const ricDetail = []; // one row per user x RIC x notice
  const ricNoticeUsers = new Set(); // notice|login pairs already covered at RIC level
  const seenRic = new Set();
  const tagged = [...matches.map(m => ({ m, bbg: false })), ...bbgMatches.map(m => ({ m, bbg: true }))];
  for (const { m, bbg } of tagged) {
    const n = noticeById.get(m.notice_id); if (!n || cancelled(n)) continue;
    const hits = (bbg ? bbgCodeMap : codeMap).get(m.code) || [];
    const heldBy = bbg ? eidsBy : permsBy; const hasHeld = bbg ? bbgPerms.length > 0 : hasPerms;
    const ct = m.change_type || '';
    const oldS = pdpSet(m.old_pdp), newS = pdpSet(m.new_pdp);
    const removed = [...oldS].filter(c => !newS.has(c)), added = [...newS].filter(c => !oldS.has(c));
    for (const { row, via } of hits) {
      const login = row.login; ricNoticeUsers.add(`${n.id}|${login}`);
      const dedupe = `${n.id}|${login}|${row.item}|${m.code}`; // usage files repeat login + RIC rows
      if (seenRic.has(dedupe)) continue; seenRic.add(dedupe);
      const ric = row.item;
      let access = 'n/a';
      if (newS.size) {
        if (!hasHeld) access = 'unchecked';
        else if (!heldBy.has(login)) access = 'not in permission file';
        else access = [...newS].some(c => heldBy.get(login).has(c)) ? 'keeps' : 'loses';
      }
      let category = 'Information', text = '';
      if (/RIC change/i.test(ct) && m.new_code) {
        category = 'Update RIC'; text = `Replace ${m.code} with ${m.new_code} in watchlists, applications and contributions.`;
        addAction(n, category, text, login, ric, { groupKey: `ric:${m.code}` });
      }
      if (/removed/i.test(ct)) {
        category = 'RIC removed'; text = 'RICs are being removed. Find replacements or take them out of watchlists and applications.';
        addAction(n, category, text, login, ric);
      }
      if (/PDP change/i.test(ct) && newS.size) {
        if (access === 'loses') {
          category = 'Order service';
          text = `Order ${[...newS].join(' or ')} for these users, or they lose access to the RICs listed${removed.length ? ` (${removed.join(', ')} no longer covers them)` : ''}.`;
          addAction(n, category, text, login, ric, { groupKey: `order:${[...newS].sort().join(',')}`, costCodes: [...newS] });
        } else if (access === 'unchecked' || access === 'not in permission file') {
          category = 'Check entitlement';
          text = `Check these users are entitled to ${[...newS].join(' or ')}${removed.length ? `: ${removed.join(', ')} no longer covers these RICs` : ''}. Load the DACS permission file to check automatically.`;
          addAction(n, category, text, login, ric, { groupKey: `check:${[...newS].sort().join(',')}`, costCodes: [...newS], costMaybe: true });
        }
      }
      if (category === 'Information' && !/RIC change|removed|PDP change/i.test(ct)) {
        category = 'Review notice'; text = `RICs you use are listed in this notice (${ct || 'change'}). Review what changes for them.`;
        addAction(n, category, text, login, ric);
      }
      ricDetail.push({ ref: n.ref, effective_date: n.effective_date, login, ric, matched_code: m.code, via, ric_name: m.ric_name || '',
        change: ct, new_code: m.new_code || '', pdp_removed: removed.join(', '), pdp_added: added.join(', '),
        new_pdps: [...newS].join(', '), access, action: category });
    }
  }

  // ---- PDP level: service changes in the summary that touch codes users hold
  const pdpDetail = [];
  if (hasPerms) {
    for (const c of changes) {
      const n = noticeById.get(c.notice_id); if (!n || n.vendor === 'Bloomberg' || cancelled(n)) continue;
      const types = (n.change_types || []).join(' | ');
      const oldS = pdpSet(c.old_pdp), newS = pdpSet(c.new_pdp);
      for (const [login, held] of permsBy) {
        const holdsOld = [...oldS].filter(x => held.has(x)), holdsNew = [...newS].filter(x => held.has(x));
        if (!holdsOld.length && !holdsNew.length) continue;
        pdpDetail.push({ ref: n.ref, login, held: uniq([...holdsOld, ...holdsNew]).join(', '), old_pdp: [...oldS].join(', '), new_pdp: [...newS].join(', '),
          old_price: c.old_price || '', new_price: c.new_price || '' });
        const coveredByRic = ricNoticeUsers.has(`${n.id}|${login}`);
        if ((c.old_price || c.new_price) && holdsOld.length) {
          addAction(n, 'Price change', `Price for ${holdsOld.join(', ')} changes from ${c.old_price || '—'} to ${c.new_price || '—'} per user. Update budgets and recharges.`, login, null, { groupKey: `price:${holdsOld.join(',')}`, priceChange: { pdp: holdsOld[0], old: c.old_price, new: c.new_price } });
        }
        if (/content removal/i.test(types) && holdsOld.length) {
          addAction(n, 'Content withdrawn', `Content under ${holdsOld.join(', ')} is being withdrawn with no alternative. Tell users and update applications.`, login, null, { groupKey: `withdrawn:${holdsOld.join(',')}` });
        }
        if (/policy/i.test(types)) {
          addAction(n, 'Review policy', `Policy change for ${uniq([...holdsOld, ...holdsNew]).join(', ')}. Review licensing and declarations.`, login, null, { groupKey: 'policy' });
        }
        const missingNew = [...newS].filter(x => !held.has(x));
        const lostOld = holdsOld.filter(x => !newS.has(x));
        if (!coveredByRic && lostOld.length && missingNew.length && /order new|map collect|permissioning/i.test(types)) {
          addAction(n, 'Check entitlement', `These users hold ${lostOld.join(', ')}, which will no longer cover some of this notice's content: it moves to ${missingNew.join(' or ')}, which they don't hold. ${lsegUsage.length ? 'None of the affected RICs appear in your usage file, so this is only needed if they use that content in ways DACS usage doesn\'t show (applications, non-display, other sites). If so, order ' + missingNew.join(' or ') + '; if not, no action.' : 'Check whether they use any RIC in this notice\'s list; if they do, order ' + missingNew.join(' or ') + '. Add your DACS usage file to check automatically.'}`, login, null, { groupKey: `pdp:${lostOld.join(',')}>${missingNew.join(',')}`, costCodes: missingNew, costMaybe: true });
        }
      }
    }
  }

  // ---- Bloomberg: notices name EIDs; users hold EIDs (permissions) and request tickers under them (usage)
  const bbgLogins = new Set([...eidsBy.keys(), ...tickersBy.keys()]);
  const hasBbg = bbgLogins.size > 0;
  const bbgDetail = [];
  if (hasBbg) {
    for (const c of changes) {
      const n = noticeById.get(c.notice_id); if (!n || n.vendor !== 'Bloomberg' || cancelled(n)) continue;
      const oldE = splitCodes(c.old_pdp), newE = splitCodes(c.new_pdp);
      const cat = (n.change_types || [])[0] || 'Change'; const act = n.action_required || '';
      const named = [...String(c.old_pe || '').split('; '), ...String(c.new_pe || '').split('; ')].filter(Boolean);
      const nm = e => named.find(x => x.startsWith(e + ' ')) || `EID ${e}`;
      if (!oldE.length && !newE.length) {
        if (!/information only/i.test(act) && !/information only/i.test(cat)) {
          addAction(n, 'Review notice', `${cat}${act ? ` (${act})` : ''}: ${n.title}. Applies to B-PIPE generally rather than particular entitlements.`, null, null, { site: true, groupKey: 'site' });
        }
        continue;
      }
      for (const login of bbgLogins) {
        const held = eidsBy.get(login) || new Set(); const used = tickersBy.get(login) || new Map();
        const has = e => held.has(e) || used.has(e);
        const holdsOld = oldE.filter(has), holdsNew = newE.filter(has);
        if (!holdsOld.length && !holdsNew.length) continue;
        const touched = uniq([...holdsOld, ...holdsNew]);
        const tickers = uniq(touched.flatMap(e => [...(used.get(e) || [])]));
        let category = 'Review notice', text = `${cat}${act ? ` (${act})` : ''} for ${touched.map(nm).join(', ')}. Review the notice.`, key = 'general';
        if (/entitlement/i.test(cat) && holdsOld.length && newE.length && !holdsNew.length) {
          category = 'Order service'; key = `order:${newE.join(',')}`;
          text = `Entitle these users to ${newE.map(nm).join(' or ')}. Content moves there from ${holdsOld.map(nm).join(', ')}; without it they lose access.`;
        } else if (/entitlement/i.test(cat) && holdsOld.length && holdsNew.length) {
          category = 'Information'; key = 'covered';
          text = `Content moves from ${holdsOld.map(nm).join(', ')} to ${holdsNew.map(nm).join(', ')}, which these users already hold.`;
        } else if (/entitlement/i.test(cat)) {
          category = 'Check entitlement'; key = 'entitlement';
          text = `Bloomberg is changing the entitlement for ${touched.map(nm).join(', ')}, which these users hold${act ? ` (Bloomberg asks: ${act})` : ''}.${newE.length ? ` The notice lists ${newE.map(nm).join(', ')} as the EID${newE.length === 1 ? '' : 's'} after the change${oldE.length ? `, replacing ${oldE.map(nm).join(', ')}` : ''}.` : ''} Check each user still holds the EIDs they need once it takes effect, and order any they're missing.`;
        } else if (/symbology|discontinu/i.test(cat)) {
          category = 'Update tickers'; key = 'symbology';
          text = `Tickers under ${touched.map(nm).join(', ')} are being replaced or discontinued. Review subscriptions and move to the replacement tickers.`;
        } else if (/fee|policy|price/i.test(cat)) {
          category = 'Review policy'; key = 'fee';
          text = `Fee or policy change for ${touched.map(nm).join(', ')}. Review costs, licensing and recharges.`;
        } else if (/data change/i.test(cat)) {
          category = 'Review data change'; key = 'data';
          text = `Data change for ${touched.map(nm).join(', ')}. Check the applications and users that rely on this data.`;
        }
        addAction(n, category, text, login, null, { groupKey: key });
        for (const t of tickers) addAction(n, category, text, login, t, { groupKey: key });
        bbgDetail.push({ ref: n.ref, login, eids: touched.join(', '), tickers: tickers.length, action: category });
        for (const e of touched) for (const t of (used.get(e) || [])) {
          const dk = `${n.id}|${login}|${t}`; if (seenRic.has(dk)) continue; seenRic.add(dk);
          ricDetail.push({ ref: n.ref, effective_date: n.effective_date, login, ric: t, matched_code: e, via: 'eid', ric_name: nm(e),
            change: cat, new_code: '', pdp_removed: oldE.includes(e) && !newE.includes(e) ? `EID ${e}` : '', pdp_added: '',
            new_pdps: newE.join(', '), access: !newE.length ? 'n/a' : holdsNew.length ? 'keeps' : 'loses', action: category });
        }
      }
    }
  }

  // ---- Assemble
  // ---- Costs from the vendor price list (indicative GBP per user per month)
  const costFor = a => {
    const n = a.users.size;
    if (a.costCodes?.length) {
      const known = a.costCodes.map(c => priceOf.get(c)).filter(Boolean);
      if (!known.length) return { cost_note: prices.length ? `No list price for ${a.costCodes.join(', ')}.` : '' };
      const priced = known.filter(p => p.price_gbp != null).sort((x, y) => x.price_gbp - y.price_gbp);
      if (!priced.length) {
        const p = known[0];
        return { cost_note: /free/i.test(p.billed_by || '') ? `${p.pdp} is free of fees.` : `${p.pdp} is billed directly by the ${/provider|exchange/i.test(p.billed_by || '') ? 'provider' : 'exchange'}; no LSEG list price.` };
      }
      const p = priced[0];
      const per = p.price_gbp, total = per * n;
      return { cost_pdp: p.pdp, cost_per_user_gbp: per, cost_month_gbp: a.costMaybe ? null : total,
        cost_note: `${p.pdp} ${p.service_name ? `(${p.service_name}) ` : ''}lists at ${money(p.user_charge, p.currency)} per user per month (about ${money(per, 'GBP')})${n > 1 ? `: about ${money(total, 'GBP')} a month for ${n} users` : ''}${a.costMaybe ? ' if needed' : ''}.${p.site_licence ? ` Site licence ${money(p.site_licence, p.currency)}.` : ''}` };
    }
    if (a.priceChange) {
      const o = parsePrice(a.priceChange.old), w = parsePrice(a.priceChange.new);
      if (!o || !w) return {};
      const d = w.v - o.v, cur = w.cur || o.cur; const p = priceOf.get(a.priceChange.pdp);
      const rate = p && p.price_gbp && p.user_charge ? p.price_gbp / p.user_charge : (cur === 'GBP' ? 1 : null);
      return { cost_delta_per_user: d, cost_currency: cur, cost_month_gbp: rate ? d * n * rate : null,
        cost_note: `${d >= 0 ? 'Up' : 'Down'} ${money(Math.abs(d), cur)} per user per month: ${d >= 0 ? '+' : '−'}${money(Math.abs(d * n), cur)} a month for ${n} user${n === 1 ? '' : 's'}${rate && cur !== 'GBP' ? ` (about ${money(Math.abs(d * n * rate), 'GBP')})` : ''}.` };
    }
    return {};
  };
  const actionList = [...actions.values()].filter(a => a.category !== 'Information' || a.users.size).map(a => ({
    ...a, ...costFor(a), users: [...a.users].sort(), rics: [...a.rics].sort(),
    user_names: [...a.users].sort().map(l => people.get(l)?.name || l),
  })).sort((a, b) => a.severity - b.severity || (a.effective_date || '').localeCompare(b.effective_date || '') || a.ref.localeCompare(b.ref));

  const byUser = new Map();
  for (const a of actionList) for (const l of a.users) {
    if (!byUser.has(l)) byUser.set(l, { ...person(l), actions: [], notices: new Set(), rics: new Set() });
    const u = byUser.get(l); u.actions.push(a); u.notices.add(a.ref);
  }
  for (const r of ricDetail) byUser.get(r.login)?.rics.add(r.ric);
  const users = [...byUser.values()].map(u => ({ ...u, notices: [...u.notices], rics: [...u.rics],
    top: Math.min(...u.actions.map(a => a.severity)) })).sort((a, b) => a.top - b.top || b.actions.length - a.actions.length);

  const byNotice = new Map();
  for (const a of actionList) {
    if (!byNotice.has(a.notice_id)) byNotice.set(a.notice_id, { ...noticeById.get(a.notice_id), actions: [], users: new Set(), rics: new Set() });
    const x = byNotice.get(a.notice_id); x.actions.push(a); a.users.forEach(l => x.users.add(l)); a.rics.forEach(r => x.rics.add(r));
  }
  const noticeList = [...byNotice.values()].map(x => ({ ...x, users: [...x.users], rics: [...x.rics],
    top: Math.min(...x.actions.map(a => a.severity)) })).sort((a, b) => a.top - b.top || (a.effective_date || '').localeCompare(b.effective_date || ''));

  const counts = {};
  actionList.forEach(a => { counts[a.category] = (counts[a.category] || 0) + 1; });
  return {
    stats: {
      usage_rows: usage.length, perm_rows: perms.length, logins: people.size, codes_checked: codeMap.size + bbgCodeMap.size,
      bpipe_usage_rows: bbgUsage.length, bpipe_perm_rows: bbgPerms.length, bpipe_logins: bbgLogins.size,
      notices_checked: notices.length, notices_affecting: noticeList.length, users_affected: users.length,
      actions: actionList.length, urgent: actionList.filter(a => a.severity === 1).length,
      urgent_users_lseg: uniq(actionList.filter(a => a.severity === 1 && a.vendor !== 'Bloomberg').flatMap(a => a.users)).length,
      urgent_users_bbg: uniq(actionList.filter(a => a.severity === 1 && a.vendor === 'Bloomberg').flatMap(a => a.users)).length,
      review_users: uniq(actionList.filter(a => a.severity === 2).flatMap(a => a.users)).length,
      bbg_site_reviews: actionList.filter(a => a.site).length,
      urgent_cost_gbp: actionList.filter(a => a.severity === 1 && a.cost_month_gbp).reduce((t, a) => t + a.cost_month_gbp, 0),
      price_change_gbp: actionList.filter(a => a.category === 'Price change' && a.cost_month_gbp).reduce((t, a) => t + a.cost_month_gbp, 0),
      priced: prices.length > 0,
      losing_access: uniq(ricDetail.filter(r => r.access === 'loses').map(r => r.login)).length,
      by_category: counts,
    },
    actions: actionList, users, notices: noticeList, ricDetail, pdpDetail, bbgDetail, people,
  };
}

/** Rows for the Excel download (one array of objects per sheet). */
export function reportSheets(report, people) {
  const name = l => people.get(l)?.name || l;
  const who = l => { const n = people.get(l)?.name; return n && n !== l ? `${n} (${l})` : l; };
  return {
    Actions: report.actions.map(a => ({ Priority: a.severity === 1 ? 'Urgent' : a.severity === 2 ? 'Review' : 'Info', Notice: a.ref, Title: a.title,
      Effective: a.effective_date || '', Due: a.due_label || a.due_date || '', Action: a.category, 'What to do': a.text,
      Vendor: a.vendor || '', Users: a.site ? 'All B-PIPE users' : a.users.map(who).join('; '), 'User count': a.users.length,
      'Cost per user (GBP/month)': a.cost_per_user_gbp != null ? Math.round(a.cost_per_user_gbp * 100) / 100 : '',
      'Est. monthly cost (GBP)': a.cost_month_gbp != null ? Math.round(a.cost_month_gbp * 100) / 100 : '', 'Cost note': a.cost_note || '', RICs: a.rics.slice(0, 50).join(' '), 'RIC count': a.rics.length })),
    'By user': report.users.flatMap(u => u.actions.map(a => ({ Login: u.login, Name: u.name, 'Cost centre': u.cost_centre, Email: u.email,
      Notice: a.ref, Title: a.title, Effective: a.effective_date || '', Due: a.due_label || a.due_date || '', Priority: a.severity === 1 ? 'Urgent' : a.severity === 2 ? 'Review' : 'Info', Action: a.category, 'Changes needed': a.text, 'Cost note': a.cost_note || '',
      [a.vendor === 'Bloomberg' ? 'Tickers' : 'RICs']: report.ricDetail.filter(d => d.login === u.login && d.ref === a.ref).map(d => d.ric).slice(0, 50).join(' ') }))),
    'By notice': report.notices.map(n => ({ Notice: n.ref, Title: n.title, Effective: n.effective_date || '', 'Change types': (n.change_types || []).join(', '),
      Users: n.users.length, RICs: n.rics.length, Actions: n.actions.map(a => `${a.category} (${a.site ? 'all B-PIPE users' : a.users.length + ' users'}): ${a.text}`).join('\n'), Summary: n.summary || '' })),
    'RIC detail': report.ricDetail.map(r => ({ Notice: r.ref, Effective: r.effective_date || '', Login: r.login, Name: name(r.login), RIC: r.ric,
      'Matched on': r.via === 'chain' ? `chain of ${r.matched_code}` : r.via === 'eid' ? `EID ${r.matched_code}` : r.matched_code, 'RIC name': r.ric_name, Change: r.change, 'New RIC': r.new_code,
      'PDP removed': r.pdp_removed, 'PDP added': r.pdp_added, 'New PDPs': r.new_pdps, Access: r.access, Action: r.action })),
    'PDP detail': report.pdpDetail.map(p => ({ Notice: p.ref, Login: p.login, Name: name(p.login), 'Holds': p.held, 'Old PDP': p.old_pdp, 'New PDP': p.new_pdp,
      'Old price': p.old_price, 'New price': p.new_price })),
  };
}
