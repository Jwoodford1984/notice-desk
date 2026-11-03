// Impact engine: turns a client's DACS files plus library matches into a list
// of affected users, notices and actions. Pure functions, no network or DOM,
// so the browser and the tests run exactly the same logic.

const isProductCode = c => /^WW/i.test(c); // LSEG Workspace product codes, not exchange PDPs
export const splitCodes = s => String(s || '').replace(/ /g, ' ').split(/[\s,;]+/).map(c => c.trim()).filter(Boolean);
const pdpSet = s => new Set(splitCodes(s).filter(c => !isProductCode(c)));
const uniq = a => [...new Set(a)];

/** Codes to send for matching: each usage item normalised, plus the base of chain RICs. */
export function usageCodes(usage) {
  const map = new Map(); // code sent -> [{ row, via }]
  for (const u of usage) {
    const norm = String(u.item || '').trim().replace(/^\//, '');
    if (!norm) continue;
    const add = (code, via) => { if (!map.has(code)) map.set(code, []); map.get(code).push({ row: u, via }); };
    add(norm, 'direct');
    const m = norm.match(/^\d#(.+)$/); if (m) add(m[1], 'chain');
  }
  return map;
}

export const SEVERITY = {
  'Update RIC': 1, 'RIC removed': 1, 'Order service': 1, 'Content withdrawn': 1,
  'Check entitlement': 2, 'Price change': 2, 'Review policy': 2, 'Review notice': 2,
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
export function buildReport({ usage = [], perms = [], notices = [], changes = [], matches = [], today }) {
  const noticeById = new Map(notices.map(n => [n.id, n]));
  const permsBy = new Map();
  for (const p of perms) { if (!permsBy.has(p.login)) permsBy.set(p.login, new Set()); permsBy.get(p.login).add(p.service_code); }
  const hasPerms = perms.length > 0;

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
      actions.set(key, { notice_id: n.id, ref: n.ref, title: n.title, effective_date: n.effective_date, due_date: d.due, due_label: d.label,
        category, severity: SEVERITY[category] || 3, text, users: new Set(), rics: new Set(), ...extra });
      delete actions.get(key).groupKey;
    }
    const a = actions.get(key);
    if (login) a.users.add(login);
    if (ric) a.rics.add(ric);
  };

  // ---- RIC level: library rows whose code appears in usage
  const codeMap = usageCodes(usage);
  const ricDetail = []; // one row per user x RIC x notice
  const ricNoticeUsers = new Set(); // notice|login pairs already covered at RIC level
  for (const m of matches) {
    const n = noticeById.get(m.notice_id); if (!n) continue;
    const hits = codeMap.get(m.code) || [];
    const ct = m.change_type || '';
    const oldS = pdpSet(m.old_pdp), newS = pdpSet(m.new_pdp);
    const removed = [...oldS].filter(c => !newS.has(c)), added = [...newS].filter(c => !oldS.has(c));
    for (const { row, via } of hits) {
      const login = row.login; ricNoticeUsers.add(`${n.id}|${login}`);
      const ric = row.item;
      let access = 'n/a';
      if (newS.size) {
        if (!hasPerms) access = 'unchecked';
        else if (!permsBy.has(login)) access = 'not in permission file';
        else access = [...newS].some(c => permsBy.get(login).has(c)) ? 'keeps' : 'loses';
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
          addAction(n, category, text, login, ric, { groupKey: `order:${[...newS].sort().join(',')}` });
        } else if (access === 'unchecked' || access === 'not in permission file') {
          category = 'Check entitlement';
          text = `Check these users are entitled to ${[...newS].join(' or ')}${removed.length ? `: ${removed.join(', ')} no longer covers these RICs` : ''}. Load the DACS permission file to check automatically.`;
          addAction(n, category, text, login, ric, { groupKey: `check:${[...newS].sort().join(',')}` });
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
      const n = noticeById.get(c.notice_id); if (!n) continue;
      const types = (n.change_types || []).join(' | ');
      const oldS = pdpSet(c.old_pdp), newS = pdpSet(c.new_pdp);
      for (const [login, held] of permsBy) {
        const holdsOld = [...oldS].filter(x => held.has(x)), holdsNew = [...newS].filter(x => held.has(x));
        if (!holdsOld.length && !holdsNew.length) continue;
        pdpDetail.push({ ref: n.ref, login, held: uniq([...holdsOld, ...holdsNew]).join(', '), old_pdp: [...oldS].join(', '), new_pdp: [...newS].join(', '),
          old_price: c.old_price || '', new_price: c.new_price || '' });
        const coveredByRic = ricNoticeUsers.has(`${n.id}|${login}`);
        if ((c.old_price || c.new_price) && holdsOld.length) {
          addAction(n, 'Price change', `Price for ${holdsOld.join(', ')} changes from ${c.old_price || '—'} to ${c.new_price || '—'} per user. Update budgets and recharges.`, login, null, { groupKey: `price:${holdsOld.join(',')}` });
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
          addAction(n, 'Check entitlement', `${lostOld.join(', ')} is being replaced by ${missingNew.join(' or ')} for some content. Check whether these users need the new service. Load DACS usage to see exactly which RICs.`, login, null, { groupKey: `pdp:${lostOld.join(',')}>${missingNew.join(',')}` });
        }
      }
    }
  }

  // ---- Assemble
  const actionList = [...actions.values()].map(a => ({
    ...a, users: [...a.users].sort(), rics: [...a.rics].sort(),
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
      usage_rows: usage.length, perm_rows: perms.length, logins: people.size, codes_checked: codeMap.size,
      notices_checked: notices.length, notices_affecting: noticeList.length, users_affected: users.length,
      actions: actionList.length, urgent: actionList.filter(a => a.severity === 1).length,
      losing_access: uniq(ricDetail.filter(r => r.access === 'loses').map(r => r.login)).length,
      by_category: counts,
    },
    actions: actionList, users, notices: noticeList, ricDetail, pdpDetail, people,
  };
}

/** Rows for the Excel download (one array of objects per sheet). */
export function reportSheets(report, people) {
  const name = l => people.get(l)?.name || l;
  return {
    Actions: report.actions.map(a => ({ Priority: a.severity === 1 ? 'Urgent' : a.severity === 2 ? 'Review' : 'Info', Notice: a.ref, Title: a.title,
      Effective: a.effective_date || '', Due: a.due_label || a.due_date || '', Action: a.category, 'What to do': a.text,
      Users: a.users.map(name).join('; '), 'User count': a.users.length, RICs: a.rics.slice(0, 50).join(' '), 'RIC count': a.rics.length })),
    'By user': report.users.flatMap(u => u.actions.map(a => ({ Login: u.login, Name: u.name, 'Cost centre': u.cost_centre, Email: u.email,
      Notice: a.ref, Effective: a.effective_date || '', Action: a.category, 'What to do': a.text }))),
    'By notice': report.notices.map(n => ({ Notice: n.ref, Title: n.title, Effective: n.effective_date || '', 'Change types': (n.change_types || []).join(', '),
      Users: n.users.length, RICs: n.rics.length, Actions: n.actions.map(a => a.category).join(', '), Summary: n.summary || '' })),
    'RIC detail': report.ricDetail.map(r => ({ Notice: r.ref, Effective: r.effective_date || '', Login: r.login, Name: name(r.login), RIC: r.ric,
      'Matched on': r.via === 'chain' ? `chain of ${r.matched_code}` : r.matched_code, 'RIC name': r.ric_name, Change: r.change, 'New RIC': r.new_code,
      'PDP removed': r.pdp_removed, 'PDP added': r.pdp_added, 'New PDPs': r.new_pdps, Access: r.access, Action: r.action })),
    'PDP detail': report.pdpDetail.map(p => ({ Notice: p.ref, Login: p.login, Name: name(p.login), 'Holds': p.held, 'Old PDP': p.old_pdp, 'New PDP': p.new_pdp,
      'Old price': p.old_price, 'New price': p.new_price })),
  };
}
