/* Dashboard KPI commerciali — tutta la logica gira nel browser sugli snapshot salvati in data/.
 *
 * Regola guida: demo e fatturato sono coorti diverse. Il fatturato si legge sempre per
 * MESE DI INCASSO; le attività (demo, attivazioni, valutazioni) per mese di attività.
 */
'use strict';

const HUBSPOT_URL = (id) => `https://app.hubspot.com/contacts/146860563/record/0-3/${id}`;
const STAGE = {
  DEMO_SCHEDULED: '4984102085', SHOW_UP: '5637822650', NO_SHOW: '5637009636',
  TRIAL_SETUP: '4984091861', TRIAL_LIVE: '4431898873', NEGOTIATION: '4431899834',
  WON: '4431899835', WON_PAID: '4961139914', LOST: '5340451029', REACTIVATION: '6012495041',
};
const TRIAL_OR_LATER = new Set([STAGE.TRIAL_SETUP, STAGE.TRIAL_LIVE, STAGE.NEGOTIATION, STAGE.WON, STAGE.WON_PAID]);

const state = {
  config: null, index: null, snaps: {}, // data -> snapshot
  asOf: null, ptype: 'month', ctype: 'prev',
  a: null, b: null, dealFilter: 'all', bridgeMonth: null,
  db: null, mcp: null, live: { state: 'saved', errors: [], at: null },
};

/* ---------- utilità date (stringhe YYYY-MM-DD, nessun fuso: sono già locali Europe/Rome) ---------- */
const D = {
  parse: (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); },
  fmt: (dt) => dt.toISOString().slice(0, 10),
  add: (s, n) => { const t = D.parse(s); t.setUTCDate(t.getUTCDate() + n); return D.fmt(t); },
  diff: (a, b) => Math.round((D.parse(a) - D.parse(b)) / 86400000),
  month: (s) => s.slice(0, 7),
  monthStart: (s) => s.slice(0, 7) + '-01',
  monthEnd: (s) => { const t = D.parse(s.slice(0, 7) + '-01'); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0); return D.fmt(t); },
  addMonths: (s, n) => { const t = D.parse(s.slice(0, 7) + '-01'); t.setUTCMonth(t.getUTCMonth() + n); return D.fmt(t); },
  day: (s) => Number(s.slice(8, 10)),
  max: (a, b) => (a > b ? a : b),
  weekStart: (s) => { const t = D.parse(s); const wd = (t.getUTCDay() + 6) % 7; return D.add(s, -wd); },
};
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const dLabel = (s) => (s ? `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]}` : '—');
const rangeLabel = (r) => `${dLabel(r.from)} – ${dLabel(r.to)} ${r.to.slice(0, 4)}`;
const inRange = (s, r) => s && s >= r.from && s <= r.to;

const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const pct = (x) => (x == null || !isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- caricamento ---------- */
async function getJSON(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Versione statica (pagina condivisibile): i dati sono incorporati nella pagina da scripts/build_static.py
const EMBEDDED = (() => { const el = document.getElementById('kpi-data'); return el ? JSON.parse(el.textContent) : null; })();
const TARGETS_KEY = 'kpi-targets-monthly';

async function load() {
  if (EMBEDDED) {
    state.config = EMBEDDED.config; state.index = EMBEDDED.index;
    EMBEDDED.snapshots.forEach((s) => { state.snaps[s.snapshot_date] = s; });
    state.asOf = state.index.latest;
    // Piani di incasso: base da data/payments.json, poi le modifiche salvate in questo browser
    state.payments = { ...(EMBEDDED.payments?.plans || {}), ...loadLocalPayments() };
    // Nella pagina statica i target modificati restano solo in questo browser
    try {
      const saved = JSON.parse(localStorage.getItem(TARGETS_KEY) || 'null');
      if (saved) state.config.targets = { ...state.config.targets, monthly: saved };
    } catch (e) { /* storage non disponibile: si usano i target della config */ }
    return;
  }
  [state.config, state.index] = await Promise.all([getJSON('../data/config.json'), getJSON('../data/index.json')]);
  const list = await Promise.all(state.index.snapshots.map((d) => getJSON(`../data/snapshots/${d}.json`).catch(() => null)));
  list.filter(Boolean).forEach((s) => { state.snaps[s.snapshot_date] = s; });
  state.asOf = state.index.latest;
  state.payments = { ...((await getJSON('../data/payments.json').catch(() => null))?.plans || {}), ...loadLocalPayments() };
}

/* ---------- modello: deal arricchiti ---------- */
const stageInfo = (id) => state.config.stages[id] || { label: `Stage sconosciuto (${id})`, group: 'unknown', order: 99 };
const isWon = (d) => stageInfo(d.stage).group === 'won';
const isOpen = (d) => stageInfo(d.stage).group === 'open';

/** Data prevista di incasso per un deal aperto, con la base del calcolo. */
function expectedIncasso(d, today) {
  const c = state.config.cycle;
  const toSign = c.evaluation_to_signature_days;
  const trialToSign = c.trial_days + toSign;
  const demoToSign = c.demo_to_activation_days + trialToSign;
  const late = c.late_evaluation_day;
  // Valutazione dopo il 27 -> incassa il mese successivo (regola operativa)
  const fromEvaluation = (ev, basis) => {
    let dt = D.add(ev, toSign);
    let lateFlag = false;
    if (D.day(ev) > late) { dt = D.max(dt, D.addMonths(ev, 1)); lateFlag = true; }
    return { date: D.max(dt, today), basis, late: lateFlag, evaluation: ev };
  };
  // La closedate di HubSpot è la data di incasso prevista dichiarata: ha la precedenza su ogni stima.
  if (d.closedate && d.closedate >= today) {
    const ev = d.evaluation_date;
    // Valutazione in calendario dopo il 27 nello stesso mese della closedate: la closedate è a rischio
    const lateFlag = !!(ev && D.day(ev) > late && D.month(ev) === D.month(d.closedate));
    return { date: d.closedate, basis: 'closedate HubSpot', fromHubspot: true, lateRisk: lateFlag, evaluation: ev };
  }
  switch (d.stage) {
    case STAGE.NEGOTIATION:
      if (d.evaluation_date && d.evaluation_date >= today) return fromEvaluation(d.evaluation_date, 'valutazione in calendario');
      return { date: D.add(today, toSign), basis: 'firma attesa entro 3 gg' };
    case STAGE.TRIAL_LIVE:
      if (d.evaluation_date && d.evaluation_date >= today) return fromEvaluation(d.evaluation_date, 'valutazione in calendario');
      if (d.activation_date) return fromEvaluation(D.max(D.add(d.activation_date, c.trial_days), today), 'attivazione + 14 gg (stima)');
      return fromEvaluation(D.add(today, 7), 'nessuna data: stima +7 gg');
    case STAGE.TRIAL_SETUP: {
      const act = d.activation_date && d.activation_date >= today ? d.activation_date : D.add(today, Math.ceil(c.demo_to_activation_days / 2));
      return fromEvaluation(D.add(act, c.trial_days), d.activation_date >= today ? 'attivazione in calendario + 14 gg' : 'attivazione da fissare (stima)');
    }
    case STAGE.SHOW_UP:
      return fromEvaluation(D.add(today, c.demo_to_activation_days + c.trial_days), 'demo fatta: attivazione da fissare');
    case STAGE.DEMO_SCHEDULED: {
      const demo = d.demo_date && d.demo_date >= today ? d.demo_date : today;
      return fromEvaluation(D.add(demo, demoToSign - toSign), d.demo_date >= today ? 'demo in calendario + 24 gg' : 'demo da confermare + 24 gg');
    }
    default:
      return null;
  }
}

function enrich(snap, today) {
  const prob = state.config.forecast_probability;
  return snap.deals.map((d) => {
    const x = { ...d, info: stageInfo(d.stage) };
    x.cohort = d.demo_date || d.createdate; // mese della demo (coorte di attività)
    if (isWon(d)) { x.incasso = d.closedate; x.p = 1; }
    else if (isOpen(d)) {
      const e = expectedIncasso(d, today);
      x.exp = e; x.incasso = e && e.date; x.p = prob[d.stage] ?? 0;
    } else { x.incasso = null; x.p = 0; }
    x.weighted = x.amount * x.p;
    x.stale = isOpen(d) ? D.diff(today, d.lastmod) : 0;
    return x;
  });
}

/* ---------- KPI di flusso (dai dati più recenti, per qualsiasi intervallo) ---------- */
function flowKpis(deals, events, r, today) {
  const won = deals.filter((d) => isWon(d) && inRange(d.closedate, r));
  const lost = deals.filter((d) => d.info.group === 'lost' && inRange(d.closedate, r));
  const past = (e) => e.date <= today;
  const evIn = (kind) => events.filter((e) => e.kind === kind && inRange(e.date, r));
  const demos = evIn('demo');
  const mat = state.config.maturity || { demo_days: 7, trial_days: 17 };
  const cohort = deals.filter((d) => d.demo_date && inRange(d.demo_date, r) && d.demo_date <= today);
  const noshow = cohort.filter((d) => d.stage === STAGE.NO_SHOW).length;
  // Demo svolte = demo fissate meno no-show (una demo passata senza esito registrato conta come svolta)
  const unrecorded = cohort.filter((d) => d.stage === STAGE.DEMO_SCHEDULED).length;
  const held = cohort.filter((d) => d.stage !== STAGE.NO_SHOW);
  const reachedTrial = (d) => funnelLevel(d, today) >= 2;
  // Coorti mature: demo da almeno N giorni; prove concluse o attivate da almeno N giorni
  const heldMature = held.filter((d) => d.demo_date <= D.add(today, -mat.demo_days));
  const trialMature = heldMature.filter(reachedTrial);
  const trialDeals = held.filter(reachedTrial);
  const trialResolved = trialDeals.filter((d) => !isOpen(d) || (d.activation_date && d.activation_date <= D.add(today, -mat.trial_days)));
  const trialResolvedWon = trialResolved.filter(isWon);
  const demoToTrial = heldMature.length ? trialMature.length / heldMature.length : null;
  const trialToWon = trialResolved.length ? trialResolvedWon.length / trialResolved.length : null;
  const cohortWon = cohort.filter(isWon);
  const heldWon = held.filter(isWon);
  const closed = won.reduce((s, d) => s + d.amount, 0);
  const reasons = {};
  lost.forEach((d) => { const k = d.lost_reason || 'non indicato'; reasons[k] = (reasons[k] || 0) + 1; });
  return {
    closed, wonCount: won.length, avgTicket: won.length ? closed / won.length : null,
    lostCount: lost.length, lostAmount: lost.reduce((s, d) => s + d.amount, 0), reasons,
    demosDone: demos.filter(past).length, demosPlanned: demos.filter((e) => !past(e)).length,
    activations: evIn('attivazione').filter(past).length, activationsPlanned: evIn('attivazione').filter((e) => !past(e)).length,
    evaluations: evIn('valutazione').filter(past).length, evaluationsPlanned: evIn('valutazione').filter((e) => !past(e)).length,
    newDeals: deals.filter((d) => inRange(d.createdate, r)).length,
    cohortSize: cohort.length, noshowCount: noshow, unrecorded, heldCount: held.length,
    showUp: cohort.length ? 1 - noshow / cohort.length : null,
    heldMatureCount: heldMature.length, trialMatureCount: trialMature.length, demoToTrial,
    trialCount: trialDeals.length, trialOpen: trialDeals.filter(isOpen).length,
    trialResolvedCount: trialResolved.length, trialWonCount: trialResolvedWon.length, trialToWon,
    // Prima data in cui una prova ancora aperta diventa matura (attivazione + giorni di maturità)
    firstMatureOn: trialDeals.filter((d) => isOpen(d) && d.activation_date && !trialResolved.includes(d))
      .map((d) => D.add(d.activation_date, mat.trial_days)).sort()[0] || null,
    // Deal vinti nel periodo, per mese della demo da cui arrivano (le chiusure di un mese vengono dalle demo del mese prima)
    wonByDemoMonth: won.reduce((o, d) => { const k = d.demo_date ? D.month(d.demo_date) : 'senza demo'; o[k] = (o[k] || 0) + 1; return o; }, {}),
    // Demo svolta -> contratto = prodotto dei due passaggi maturi
    demoToWon: demoToTrial != null && trialToWon != null ? demoToTrial * trialToWon : null,
    trialResolvedValue: trialResolved.reduce((s, d) => s + d.amount, 0),
    trialResolvedWonValue: trialResolvedWon.reduce((s, d) => s + d.amount, 0),
    cohortWonCount: cohortWon.length, heldWonCount: heldWon.length,
    cohortOpen: cohort.filter(isOpen).length,
    demoToWonAll: cohort.length ? cohortWon.length / cohort.length : null,
    demoToWonHeld: held.length ? heldWon.length / held.length : null,
  };
}

/* ---------- KPI di stato (dallo snapshot più vicino alla data) ---------- */
function snapshotAt(date) {
  const dates = Object.keys(state.snaps).sort().filter((d) => d <= date);
  return dates.length ? state.snaps[dates[dates.length - 1]] : null;
}
function stockKpis(snap) {
  if (!snap) return null;
  const today = snap.snapshot_date;
  const deals = enrich(snap, today);
  const open = deals.filter(isOpen);
  const m = D.month(today);
  const closedMonth = deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m).reduce((s, d) => s + d.amount, 0);
  const weightedMonth = open.filter((d) => d.incasso && D.month(d.incasso) === m).reduce((s, d) => s + d.weighted, 0);
  return {
    date: today, deals,
    openValue: open.reduce((s, d) => s + d.amount, 0),
    openCount: open.length,
    weightedValue: open.reduce((s, d) => s + d.weighted, 0),
    inTrial: open.filter((d) => d.stage === STAGE.TRIAL_LIVE).length,
    closedMonth, forecastMonth: closedMonth + weightedMonth,
    byStage: Object.fromEntries(Object.keys(state.config.stages).concat(['unknown']).map((k) => [k, { n: 0, v: 0 }])),
  };
}

/** Inizio del periodo di riferimento (config.analysis_start): totali, coorti e grafici partono da qui. */
const analysisStart = () => state.config.analysis_start?.date || '2000-01-01';

/* ---------- periodi ---------- */
function periodFor(type, anchor) {
  if (type === 'week') { const f = D.weekStart(anchor); return { from: f, to: D.add(f, 6) }; }
  if (type === 'quarter') {
    const q = Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) * 3 + 1;
    const f = `${anchor.slice(0, 4)}-${String(q).padStart(2, '0')}-01`;
    return { from: f, to: D.monthEnd(D.addMonths(f, 2)) };
  }
  return { from: D.monthStart(anchor), to: D.monthEnd(anchor) };
}
function shift(r, type, dir) {
  if (type === 'month') { const f = D.addMonths(r.from, dir); return { from: f, to: D.monthEnd(f) }; }
  if (type === 'quarter') { const f = D.addMonths(r.from, 3 * dir); return { from: f, to: D.monthEnd(D.addMonths(f, 2)) }; }
  const len = D.diff(r.to, r.from) + 1;
  return { from: D.add(r.from, dir * len), to: D.add(r.to, dir * len) };
}
/** Target del mese: valore specifico del mese, altrimenti il default dal mese indicato in poi. */
function targetOf(m) {
  const t = state.config.targets || {};
  if (t.monthly?.[m] != null) return t.monthly[m];
  if (t.default_from && m >= t.default_from.month) return t.default_from.value;
  return null;
}

/** Commissioni del mese (contratto): 0 sotto il 70% della quota; poi 8% fino alla quota, 10% oltre la quota fino a 35.000, 15% oltre. */
function commissionFor(sales, target) {
  const c = state.config.compensation;
  if (!c || !target || sales < c.threshold_pct * target) return 0;
  const top = Math.max(target, c.upper_from);
  return c.base_rate * Math.min(sales, target) + c.quota_rate * Math.max(0, Math.min(sales, top) - target)
    + c.upper_rate * Math.max(0, sales - top);
}

/** Netto annuo stimato di un lavoratore dipendente con lordo annuo G (INPS, IRPEF, detrazioni, cuneo 2025, addizionali). */
function netAnnual(G, p) {
  const inps = G * p.inps_rate + Math.max(0, G - p.inps_extra_from) * p.inps_extra_rate;
  const R = G - inps;
  let irpef = 0, low = 0;
  for (const [upTo, rate] of p.irpef_brackets) {
    const top = upTo == null ? R : Math.min(R, upTo);
    if (top > low) irpef += (top - low) * rate;
    if (upTo == null || R <= upTo) break;
    low = upTo;
  }
  // Detrazione lavoro dipendente (art. 13 TUIR)
  let detr = R <= 15000 ? 1955 : R <= 28000 ? 1910 + 1190 * (28000 - R) / 13000 : R <= 50000 ? 1910 * (50000 - R) / 22000 : 0;
  if (R > 25000 && R <= 35000) detr += 65;
  // Cuneo fiscale 2025: somma esente fino a 20.000, ulteriore detrazione da 20.000 a 40.000
  const esente = R <= 8500 ? R * 0.071 : R <= 15000 ? R * 0.053 : R <= 20000 ? R * 0.048 : 0;
  if (R > 20000 && R <= 32000) detr += 1000;
  else if (R > 32000 && R <= 40000) detr += 1000 * (40000 - R) / 8000;
  return G - inps - Math.max(0, irpef - detr) - R * p.addizionali_rate + esente;
}

/** Aliquota effettiva sulle commissioni di un anno: quanto del lordo commissioni se ne va in contributi e tasse. */
function commissionTaxRate(annualComm, p) {
  const base = p.hypotheses[p.hypothesis].base_gross;
  const C = Math.max(annualComm, 1);
  return 1 - (netAnnual(base + C, p) - netAnnual(base, p)) / C;
}

function targetFor(r) {
  // Somma dei target dei mesi interamente contenuti nel periodo
  const t = new Proxy({}, { get: (_, m) => targetOf(m) });
  let sum = 0, any = false;
  for (let m = D.monthStart(r.from); m <= r.to; m = D.addMonths(m, 1)) {
    if (m >= r.from && D.monthEnd(m) <= r.to && t[D.month(m)] != null) { sum += t[D.month(m)]; any = true; }
  }
  return any ? sum : null;
}

/* ---------- rendering helpers ---------- */
function delta(a, b, { money = false, isPct = false, invert = false } = {}) {
  if (a == null || b == null) return '<span class="flat">confronto n/d</span>';
  const d = a - b;
  if (Math.abs(d) < 1e-9) return `<span class="flat">= vs ${fmtVal(b, money, isPct)}</span>`;
  const good = invert ? d < 0 : d > 0;
  const arrow = d > 0 ? '▲' : '▼';
  const rel = !isPct && b ? ` (${d > 0 ? '+' : ''}${Math.round((d / b) * 100)}%)` : '';
  const abs = isPct ? `${d > 0 ? '+' : ''}${Math.round(d * 100)} pt` : `${d > 0 ? '+' : ''}${money ? eur.format(d) : num.format(d)}`;
  return `<span class="${good ? 'up' : 'down'}">${arrow} ${abs}${rel}</span> <span class="flat">vs ${fmtVal(b, money, isPct)}</span>`;
}
function fmtVal(v, money, isPct) {
  if (v == null) return '—';
  if (isPct) return pct(v);
  return money ? eur.format(v) : num.format(v);
}
function tile(k, v, cmp = '', note = '', extra = '') {
  return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${extra}${cmp ? `<div class="cmp">${cmp}</div>` : ''}${note ? `<div class="note">${note}</div>` : ''}</div>`;
}

const tipEl = () => document.getElementById('tip');
function showTip(html, ev) {
  const t = tipEl(); t.innerHTML = html; t.hidden = false;
  const x = Math.min(ev.clientX + 14, window.innerWidth - t.offsetWidth - 8);
  const y = Math.max(8, ev.clientY - t.offsetHeight - 10);
  t.style.left = `${x}px`; t.style.top = `${y}px`;
}
const hideTip = () => { tipEl().hidden = true; };

/* ---------- grafici SVG ---------- */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
function barChart(el, data, { money = false, highlight = null } = {}) {
  if (!data.length) { el.innerHTML = '<p class="empty">Nessun dato.</p>'; return; }
  const W = 560, H = 220, L = money ? 56 : 34, R = 8, T = 16, B = 26;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const bw = (W - L - R) / data.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  ticks.forEach((t) => {
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${money ? eur.format(t).replace(/\s?€/, '') + '€' : num.format(t)}</text>`;
  });
  data.forEach((d, i) => {
    const x = L + i * bw + bw * 0.2, w = bw * 0.6, top = y(d.value), h = Math.max(0, y(0) - top);
    const r = Math.min(4, w / 2, h);
    const fill = d.key === highlight ? 'var(--s2)' : 'var(--s1)';
    s += h > 0
      ? `<path d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y(0)} Z" fill="${fill}"/>`
      : '';
    s += `<text class="val" x="${x + w / 2}" y="${top - 4}" text-anchor="middle">${money ? (d.value ? `${Math.round(d.value / 100) / 10}k` : '') : d.value || ''}</text>`;
    s += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    s += `<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" data-i="${i}"/>`;
  });
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
  el.innerHTML = s;
  el.querySelectorAll('.hit').forEach((h) => {
    const d = data[Number(h.dataset.i)];
    h.addEventListener('mousemove', (ev) => showTip(`<b>${esc(d.label)}</b><br>${money ? eur.format(d.value) : d.value}${d.tip ? `<br>${d.tip}` : ''}`, ev));
    h.addEventListener('mouseleave', hideTip);
  });
}

function lineChart(el, series) {
  const pts = series.flatMap((s) => s.points);
  const xs = [...new Set(pts.map((p) => p.x))].sort();
  if (xs.length < 2) {
    el.innerHTML = `<p class="empty">Serve almeno un secondo snapshot per disegnare i trend (oggi: ${xs.length}). Ogni aggiornamento ne aggiunge uno.</p>`;
    return;
  }
  const W = 900, H = 240, L = 64, R = 16, T = 12, B = 26;
  const max = niceMax(Math.max(...pts.map((p) => p.y)));
  const x0 = D.parse(xs[0]), span = D.parse(xs[xs.length - 1]) - x0 || 1;
  const x = (d) => L + (W - L - R) * ((D.parse(d) - x0) / span);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  [0, 0.5, 1].forEach((f) => {
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(f * max)}" y2="${y(f * max)}"/>`;
    s += `<text x="${L - 6}" y="${y(f * max) + 4}" text-anchor="end">${eur.format(f * max)}</text>`;
  });
  [xs[0], xs[xs.length - 1]].forEach((d, i) => { s += `<text x="${x(d)}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${dLabel(d)}</text>`; });
  series.forEach((sr) => {
    s += `<path d="${sr.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join(' ')}" fill="none" stroke="${sr.color}" stroke-width="2"/>`;
    sr.points.forEach((p) => { s += `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="4" fill="${sr.color}" stroke="var(--surface)" stroke-width="2"/>`; });
  });
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  s += `<line id="xhair" class="axis" y1="${T}" y2="${y(0)}" visibility="hidden"/>`;
  s += `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg>`;
  const legend = `<div class="legend">${series.map((sr) => `<span><i style="background:${sr.color}"></i>${esc(sr.name)}</span>`).join('')}</div>`;
  el.innerHTML = legend + s;
  const svg = el.querySelector('svg'), hair = el.querySelector('#xhair');
  el.querySelector('.hit').addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * W;
    const near = xs.reduce((a, b) => (Math.abs(x(b) - vx) < Math.abs(x(a) - vx) ? b : a));
    hair.setAttribute('x1', x(near)); hair.setAttribute('x2', x(near)); hair.setAttribute('visibility', 'visible');
    const rows = series.map((sr) => { const p = sr.points.find((q) => q.x === near); return p ? `<i style="display:inline-block;width:8px;height:8px;background:${sr.color};border-radius:2px"></i> ${esc(sr.name)}: <b>${eur.format(p.y)}</b>` : ''; });
    showTip(`<b>Snapshot ${dLabel(near)} ${near.slice(0, 4)}</b><br>${rows.join('<br>')}`, ev);
  });
  el.querySelector('.hit').addEventListener('mouseleave', () => { hair.setAttribute('visibility', 'hidden'); hideTip(); });
}

/** Giorni lavorativi (lun-ven, escluse le festività nazionali) tra due date incluse. */
function workdays(from, to) {
  if (!from || !to || to < from) return 0;
  const easterMonday = (y) => { // calcolo di Pasqua (algoritmo di Gauss/Meeus) + 1 giorno
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return D.add(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 1);
  };
  const fixed = ['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'];
  let n = 0;
  for (let d = from; d <= to; d = D.add(d, 1)) {
    const wd = D.parse(d).getUTCDay();
    if (wd === 0 || wd === 6 || fixed.includes(d.slice(5)) || d === easterMonday(Number(d.slice(0, 4)))) continue;
    n += 1;
  }
  return n;
}

/* ---------- sezioni ---------- */
function renderResult(latest, A, B) {
  const fa = flowKpis(latest.deals, latest.events, state.a, state.asOf);
  const fb = flowKpis(latest.deals, latest.events, state.b, state.asOf);
  const target = targetFor(state.a), targetB = targetFor(state.b);
  const isMonth = D.monthStart(state.a.from) === state.a.from && D.monthEnd(state.a.from) === state.a.to;
  const m = D.month(state.a.from);
  // Previsto per il mese di incasso del periodo (solo se il periodo è un mese)
  const pipeM = latest.deals.filter((d) => isOpen(d) && d.incasso && D.month(d.incasso) === m);
  const forecast = fa.closed + pipeM.reduce((s, d) => s + d.weighted, 0);
  const ratio = target ? fa.closed / target : null;
  document.getElementById('resHint').innerHTML =
    `Periodo <b>${rangeLabel(state.a)}</b> confrontato con <b>${rangeLabel(state.b)}</b>. Chiuso = Closed Won + Closed Won Paid con closedate nel periodo.`;
  let h = '';
  h += tile('Chiuso nel periodo', eur.format(fa.closed), delta(fa.closed, fb.closed, { money: true }), `${fa.wonCount} deal vinti`);
  h += tile('Target', target != null ? eur.format(target) : '—', '', target == null ? 'Da impostare (sotto)' : '');
  h += tile('% target raggiunto', pct(ratio),
    target && targetB ? delta(ratio, fb.closed / targetB, { isPct: true }) : '',
    '', ratio != null ? `<div class="bar"><span style="width:${Math.min(100, ratio * 100)}%"></span></div>` : '');
  h += tile('Gap a target', target != null ? eur.format(Math.max(0, target - fa.closed)) : '—', '', target != null && fa.closed >= target ? 'Target raggiunto' : '');
  if (isMonth) {
    h += tile(`Previsto incasso ${monthLabel(m)}`, eur.format(forecast), '',
      `Chiuso + pipeline pesata che incassa a ${monthLabel(m)} (${pipeM.length} deal)${target ? ` · ${pct(forecast / target)} del target` : ''}`);
  }
  h += tile('Deal persi', num.format(fa.lostCount), delta(fa.lostCount, fb.lostCount, { invert: true }),
    Object.entries(fa.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)}: ${v}`).join(' · '));
  document.getElementById('tilesResult').innerHTML = h;

  // KPI chiave in testa: demo del periodo e conversioni (solo demo svolte)
  const fk = flowKpis(latest.deals, latest.events, { from: analysisStart(), to: state.asOf }, state.asOf);
  const sinceL = monthLabel(D.month(analysisStart()));
  let k = '';
  k += tile('Demo fatte', num.format(fa.demosDone), delta(fa.demosDone, fb.demosDone),
    `+ <b>${fa.demosPlanned}</b> ancora in calendario → <b>${fa.demosDone + fa.demosPlanned}</b> demo nel periodo (eventi demo del calendario, anche senza deal)`);
  const kFirst = k; k = '';
  k += tile('Tasso di presentazione', pct(fa.showUp), delta(fa.showUp, fb.showUp, { isPct: true }),
    `${fa.heldCount} svolte su ${fa.cohortSize} fissate · ${fa.noshowCount} no-show${fa.unrecorded ? ` · ${fa.unrecorded} senza esito in HubSpot (contate come svolte)` : ''} · da ${sinceL}: <b>${pct(fk.showUp)}</b>`);
  k += tile('Demo → trial', pct(fa.demoToTrial), delta(fa.demoToTrial, fb.demoToTrial, { isPct: true }),
    `${fa.trialMatureCount} attivazioni su ${fa.heldMatureCount} demo svolte da almeno ${state.config.maturity?.demo_days ?? 7} giorni · da ${sinceL}: <b>${pct(fk.demoToTrial)}</b> (${fk.trialMatureCount} su ${fk.heldMatureCount})`);
  // Coorte non ancora matura (es. il mese in corso): invece del trattino, stima con il tasso storico e data in cui diventa reale
  const wonFrom = Object.entries(fa.wonByDemoMonth).sort().map(([m, n]) => `${m === 'senza demo' ? `${n} senza demo in calendario` : `${n} da demo di ${monthLabel(m)}`}`).join(', ');
  const closedNote = fa.wonCount ? ` · chiusure del periodo: ${fa.wonCount} (${wonFrom})` : '';
  const maturing = fa.firstMatureOn ? `prime prove mature dal <b>${dLabel(fa.firstMatureOn)}</b>` : 'nessuna prova ancora matura';
  if (fa.trialToWon != null) {
    k += tile('Trial → chiusura', pct(fa.trialToWon), delta(fa.trialToWon, fb.trialToWon, { isPct: true }),
      `${fa.trialWonCount} vinte su ${fa.trialResolvedCount} prove concluse${fa.trialOpen ? ` · ${fa.trialOpen} in corso` : ''} · da ${sinceL}: <b>${pct(fk.trialToWon)}</b> (${fk.trialWonCount} su ${fk.trialResolvedCount})${closedNote}`);
  } else {
    k += tile('Trial → chiusura', 'In maturazione', `<span class="flat">stima ${pct(fk.trialToWon)} (media da ${sinceL})</span>`,
      `Le ${fa.trialCount} prove nate dalle demo del periodo sono ancora in corso: ${maturing}${closedNote}`);
  }
  if (fa.demoToWon != null) {
    k += tile('Demo → chiusura', pct(fa.demoToWon), delta(fa.demoToWon, fb.demoToWon, { isPct: true }),
      `demo → trial × trial → chiusura, su coorti mature · da ${sinceL}: <b>${pct(fk.demoToWon)}</b>`);
  } else {
    const est = fa.demoToTrial != null && fk.trialToWon != null ? fa.demoToTrial * fk.trialToWon : fk.demoToWon;
    k += tile('Demo → chiusura', 'In maturazione', `<span class="flat">stima ${pct(est)}</span>`,
      `Demo → trial del periodo ${pct(fa.demoToTrial)} × trial → chiusura da ${sinceL} ${pct(fk.trialToWon)} · dato reale quando le prove si concludono · da ${sinceL}: <b>${pct(fk.demoToWon)}</b>`);
  }
  // Ritmo: demo fissate (eventi demo in calendario fino a oggi, no-show compresi) e svolte (fissate × presentazione)
  // per giorno lavorativo trascorso, confrontate col fabbisogno: le demo di un mese alimentano il target del mese dopo.
  const elapsedTo = state.a.to < state.asOf ? state.a.to : state.asOf;
  const wdA = workdays(state.a.from, elapsedTo), wdB = workdays(state.b.from, state.b.to < state.asOf ? state.b.to : state.asOf);
  const showA = fa.showUp ?? fk.showUp, showB = fb.showUp ?? fk.showUp;
  const bookedDay = wdA ? fa.demosDone / wdA : null, bookedDayB = wdB ? fb.demosDone / wdB : null;
  const heldDay = bookedDay != null && showA != null ? bookedDay * showA : null;
  const heldDayB = bookedDayB != null && showB != null ? bookedDayB * showB : null;
  const fall0 = flowKpis(latest.deals, latest.events, { from: analysisStart(), to: state.asOf }, state.asOf);
  const perDemo0 = fall0.demoToWon != null && fall0.avgTicket ? fall0.demoToWon * fall0.avgTicket : null;
  // Il fabbisogno giornaliero vale per qualsiasi periodo: si usa il mese in cui il periodo inizia
  const feedM = D.month(D.addMonths(state.a.from, 1)), feedT = targetOf(feedM);
  const wdMonth = workdays(D.monthStart(state.a.from), D.monthEnd(state.a.from));
  const needHeld = perDemo0 && feedT ? feedT / perDemo0 : null; // demo svolte nel mese per il target del mese dopo
  const needHeldDay = needHeld && wdMonth ? needHeld / wdMonth : null;
  const needBookedDay = needHeldDay && fk.showUp ? needHeldDay / fk.showUp : null;
  const wdLeft = isMonth ? workdays(D.add(elapsedTo, 1), state.a.to) : 0;
  const heldSoFar = fa.demosDone * (showA ?? 1);
  const leftPerDay = needHeld && wdLeft ? Math.max(0, needHeld - heldSoFar) / wdLeft : null;
  const dec = (v) => (v == null ? '—' : v.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const vsNeed = (v, need) => (v == null || need == null ? '' : v >= need
    ? `<span class="up">in linea: fabbisogno ${dec(need)}/giorno</span>` : `<span class="down">sotto il fabbisogno di ${dec(need)}/giorno (−${dec(need - v)})</span>`);
  let kp = '';
  kp += tile('Demo fissate al giorno', dec(bookedDay), vsNeed(bookedDay, needBookedDay),
    `${fa.demosDone} demo in calendario su ${wdA} giorni lavorativi trascorsi${bookedDayB != null ? ` · periodo di confronto: ${dec(bookedDayB)}` : ''}${needBookedDay ? ` · fabbisogno = svolte necessarie ÷ presentazione ${pct(fk.showUp)}` : ''}`);
  kp += tile('Demo svolte al giorno', dec(heldDay), vsNeed(heldDay, needHeldDay),
    `Fissate × tasso di presentazione ${pct(showA)}${heldDayB != null ? ` · periodo di confronto: ${dec(heldDayB)}` : ''}${needHeld ? ` · per il target di ${monthLabel(feedM)} (${eur.format(feedT)}) servono ${num.format(Math.ceil(needHeld))} svolte a ${monthLabel(D.month(state.a.from))} (${wdMonth} giorni lavorativi)${wdLeft ? (leftPerDay > 0 ? `: nei ${wdLeft} giorni rimasti <b>${dec(leftPerDay)}/giorno</b>` : ': <b>fabbisogno del mese già coperto</b>') : ''}` : ''}`);
  // Ritmo subito dopo le demo fatte, poi le conversioni
  document.getElementById('tilesKey').innerHTML = kFirst + kp + k;

  // Conversione e vendite: periodo selezionato + totale dall'inizio dei dati
  const fall = flowKpis(latest.deals, latest.events, { from: analysisStart(), to: state.asOf }, state.asOf);
  const open = (k) => (k.cohortOpen ? ` · ${k.cohortOpen} ancora in trattativa` : '');
  let cv = '';
  cv += tile('Vendite nel periodo', num.format(fa.wonCount), delta(fa.wonCount, fb.wonCount),
    `Da ${monthLabel(D.month(analysisStart()))}: <b>${num.format(fall.wonCount)}</b> vendite (${eur.format(fall.closed)})`);
  cv += tile('Ticket medio', fa.avgTicket != null ? eur.format(fa.avgTicket) : '—', delta(fa.avgTicket, fb.avgTicket, { money: true }),
    `Da ${monthLabel(D.month(analysisStart()))}: <b>${fall.avgTicket != null ? eur.format(fall.avgTicket) : '—'}</b> su ${fall.wonCount} vendite`);
  // Valore atteso di una demo svolta e demo necessarie per il target del mese successivo (che incassa le demo di questo)
  const perDemo = fall.demoToWon != null && fall.avgTicket ? fall.demoToWon * fall.avgTicket : null;
  const nextM = D.month(D.addMonths(state.asOf, 1));
  const nextT = targetOf(nextM);
  cv += tile('Valore atteso per demo svolta', perDemo != null ? eur.format(perDemo) : '—', '',
    `Demo → chiusura ${pct(fall.demoToWon)} × ticket medio ${fall.avgTicket ? eur.format(fall.avgTicket) : '—'} (da ${monthLabel(D.month(analysisStart()))})`);
  cv += tile(`Demo svolte necessarie per ${monthLabel(nextM)}`, perDemo && nextT ? num.format(Math.ceil(nextT / perDemo)) : '—', '',
    nextT ? `Target ${eur.format(nextT)} ÷ ${perDemo ? eur.format(perDemo) : '—'} per demo. ${monthLabel(nextM)} incassa le demo di ${monthLabel(D.month(state.asOf))}: finora ${fa.heldCount} svolte${fa.demosPlanned ? `, ${fa.demosPlanned} ancora in calendario` : ''}` : 'Target non impostato');
  document.getElementById('tilesConversion').innerHTML = cv;

  const sa = stockKpis(snapshotAt(state.a.to)), sb = stockKpis(snapshotAt(state.b.to));
  let act = '';
  act += tile('Demo svolte', num.format(fa.demosDone), delta(fa.demosDone, fb.demosDone), fa.demosPlanned ? `+ ${fa.demosPlanned} in calendario nel periodo` : '');
  act += tile('Show-up rate', pct(fa.showUp), delta(fa.showUp, fb.showUp, { isPct: true }), `su ${fa.cohortSize - fa.unrecorded} demo con esito registrato${fa.unrecorded ? ` · ${fa.unrecorded} ancora in Demo Scheduled` : ''}`);
  act += tile('Demo → prova', pct(fa.demoToTrial), delta(fa.demoToTrial, fb.demoToTrial, { isPct: true }), `${fa.trialCount} prove su ${fa.heldCount} demo svolte (esclusi no-show ed esiti non registrati)`);
  act += tile('Attivazioni prova', num.format(fa.activations), delta(fa.activations, fb.activations), fa.activationsPlanned ? `+ ${fa.activationsPlanned} in calendario` : '');
  act += tile('Valutazioni fine prova', num.format(fa.evaluations), delta(fa.evaluations, fb.evaluations), fa.evaluationsPlanned ? `+ ${fa.evaluationsPlanned} in calendario` : '');
  act += tile('Nuovi deal creati', num.format(fa.newDeals), delta(fa.newDeals, fb.newDeals));
  act += tile('Pipeline aperta a fine periodo', sa ? eur.format(sa.openValue) : 'n/d', sa && sb ? delta(sa.openValue, sb.openValue, { money: true }) : '<span class="flat">serve uno snapshot del periodo di confronto</span>',
    sa ? `snapshot del ${dLabel(sa.date)} · ${sa.openCount} deal` : 'nessuno snapshot entro fine periodo');
  act += tile('In prova (Trial Live)', sa ? num.format(sa.inTrial) : 'n/d', sa && sb ? delta(sa.inTrial, sb.inTrial) : '');
  document.getElementById('tilesActivity').innerHTML = act;
}

/* ---------- Commissioni: maturate sul chiuso del mese e previste sul forecast ---------- */
/* ---------- Piani di incasso dei deal chiusi ---------- */
// FIRMATO vs INCASSATO: la commissione MATURA sul contrattato del mese di firma (closedate HubSpot, scaglioni sul
// totale del mese) e viene EROGATA in busta solo nel mese in cui il cliente paga ciascuna rata.
// Ogni deal ha un piano con le sue rate, salvate così come sono (non ricalcolate a ogni apertura): nel database
// della dashboard (collection `payments`, un documento per deal) e, come base, in data/payments.json.
// Rata: { amount, date: 'AAAA-MM-GG' oppure '' (data da confermare), status: 'paid' (incassata) | 'expected' (da incassare) }.
const PAY_KEY = 'kpi-payment-plans';
const PLAN_LABELS = { single: 'Unica soluzione', quarterly: 'Trimestrale (3 rate ogni 3 mesi)', semiannual: 'Semestrale (2 rate ogni 6 mesi)', custom: 'Personalizzato' };
const PLAN_TEMPLATES = { single: { n: 1, every: 0 }, quarterly: { n: 3, every: 3 }, semiannual: { n: 2, every: 6 } };

/** Stessa data N mesi dopo (31/01 + 1 mese = 28/02). */
function addMonthsDay(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
/** Rate generate da un modello: importi uguali (arrotondamento sull'ultima), prima rata alla firma. Solo alla scelta del piano. */
function buildInstallments(plan, deal) {
  const tpl = PLAN_TEMPLATES[plan] || PLAN_TEMPLATES.single;
  const each = Math.round(deal.amount / tpl.n);
  return Array.from({ length: tpl.n }, (_, k) => ({
    amount: k === tpl.n - 1 ? deal.amount - each * (tpl.n - 1) : each,
    date: addMonthsDay(deal.closedate, k * tpl.every),
    // la rata alla firma di un deal già firmato si considera incassata; le successive sono da incassare
    status: k === 0 && deal.closedate <= state.asOf ? 'paid' : 'expected',
  }));
}
/** Piano salvato del deal o, se non c'è, il caso standard: unica soluzione incassata alla firma. */
function payPlan(deal) {
  const saved = state.payments?.[deal.id];
  if (saved?.installments?.length) return { plan: saved.plan in PLAN_LABELS ? saved.plan : 'custom', installments: saved.installments, saved: true };
  return { plan: 'single', installments: buildInstallments('single', deal), saved: false };
}
function loadLocalPayments() {
  try { return JSON.parse(localStorage.getItem(PAY_KEY) || 'null') || {}; } catch (e) { return {}; }
}
async function savePayment(id, plan) {
  const doc = { deal_id: String(id), plan: plan.plan, installments: plan.installments, updated_at: new Date().toISOString() };
  const note = state.payments?.[id]?.note;
  if (note) doc.note = note;
  state.payments = { ...(state.payments || {}), [id]: doc };
  if (state.db) { await state.db.doc(`payments/${id}`).set(doc); return 'db'; }
  try { localStorage.setItem(PAY_KEY, JSON.stringify(state.payments)); } catch (e) { /* storage non disponibile */ }
  return 'local';
}

function renderCommissions(latest) {
  const c = state.config.compensation;
  if (!c) return;
  if (!state.payments) state.payments = {};
  const cur = D.month(state.asOf);
  const lag = c.payment_lag_months ?? 0;
  const addM = (m, n) => D.month(D.addMonths(`${m}-01`, n));
  // La busta del mese si paga la prima settimana del mese successivo
  const paidOn = (P) => monthLabel(addM(P, 1));
  const months = [];
  for (let m = D.monthStart(analysisStart()); D.month(m) <= D.month(D.addMonths(state.asOf, 2)); m = D.addMonths(m, 1)) months.push(D.month(m));
  const rows = months.map((m) => {
    const target = targetOf(m);
    const closed = latest.deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m).reduce((s, d) => s + d.amount, 0);
    const weighted = m >= cur ? latest.deals.filter((d) => isOpen(d) && d.incasso && D.month(d.incasso) === m).reduce((s, d) => s + d.weighted, 0) : 0;
    const forecast = closed + weighted;
    return { m, target, threshold: target ? target * c.threshold_pct : null, closed, forecast,
      comm: commissionFor(closed, target), commF: commissionFor(forecast, target) };
  });
  const rowOf = Object.fromEntries(rows.map((x) => [x.m, x]));
  const r = rowOf[cur] || rows[rows.length - 1];

  // FIRMATO: la commissione del mese di firma si ripartisce sui deal in proporzione all'importo.
  const alloc = latest.deals.filter((d) => isWon(d) && d.closedate && rowOf[D.month(d.closedate)]).map((d) => {
    const x = rowOf[D.month(d.closedate)];
    const gross = x.closed ? (x.comm * d.amount) / x.closed : 0;
    const grossF = x.m >= cur && x.forecast ? (x.commF * d.amount) / x.forecast : gross;
    return { d, m: x.m, gross, grossF, plan: payPlan(d) };
  }).sort((a, b) => b.d.closedate.localeCompare(a.d.closedate));
  // INCASSATO: ogni rata porta la sua quota di commissione (importo rata / importo deal) nella busta del mese
  // in cui il cliente paga. gross = erogato (rate incassate), grossF = erogato + previsto (rate da incassare),
  // pend = maturato ma non ancora incassato. Una rata senza data resta fuori da ogni busta (unplanned).
  const slip = {};
  const slot = (P) => (slip[P] ||= { gross: 0, grossF: 0, pend: 0, parts: {}, partsF: {} });
  let unplanned = 0, overdue = 0;
  alloc.forEach((a) => a.plan.installments.forEach((ins) => {
    const share = a.d.amount ? (Number(ins.amount) || 0) / a.d.amount : 0;
    if (!ins.date) { unplanned += a.gross * share; return; }
    const P = addM(D.month(ins.date), lag), o = slot(P);
    o.grossF += a.grossF * share; o.partsF[a.m] = (o.partsF[a.m] || 0) + a.grossF * share;
    if (ins.status === 'paid') { o.gross += a.gross * share; o.parts[a.m] = (o.parts[a.m] || 0) + a.gross * share; }
    else { o.pend += a.gross * share; if (ins.date < state.asOf) overdue += 1; }
  }));
  // La parte pesata della pipeline (non ancora firmata) si assume incassata in unica soluzione nel mese previsto
  rows.filter((x) => x.m >= cur).forEach((x) => {
    const rest = x.commF - (x.forecast ? (x.commF * x.closed) / x.forecast : 0);
    const o = slot(addM(x.m, lag));
    o.grossF += rest; o.partsF[x.m] = (o.partsF[x.m] || 0) + rest;
  });
  const slips = [];
  const lastSlip = [addM(months[months.length - 1], lag), ...Object.keys(slip)].sort().pop();
  for (let P = addM(months[0], lag); P <= lastSlip; P = addM(P, 1)) slips.push({ P, ...slot(P) });
  rows.forEach((x) => {
    x.paidNow = slot(addM(x.m, lag)).parts[x.m] || 0;
    x.deferred = x.comm - x.paidNow;
  });

  // Netto stimato per busta: i primi ~1.000 € di commissione in ogni busta sono benefit esenti, il resto è tassato
  // con l'aliquota effettiva dell'anno della busta (IRPEF sul reddito annuo cumulato; mesi senza dati = media).
  const p = c.payroll;
  const fixedNet = p ? p.net_fixed : c.net_salary, meal = p ? p.meal_vouchers : 0, salary = fixedNet + meal;
  const benefit = (gross) => (p ? Math.min(gross, p.commission_benefit_monthly || 0) : 0);
  const taxable = (gross) => gross - benefit(gross);
  const expected = (s) => (s.P >= cur ? s.grossF : s.gross);
  const yearRate = {};
  if (p) {
    const avg = slips.reduce((t, s) => t + taxable(expected(s)), 0) / slips.length;
    const firstSlip = slips[0].P;
    [...new Set(slips.map((s) => s.P.slice(0, 4)))].forEach((y) => {
      const ys = slips.filter((s) => s.P.startsWith(y)).map((s) => taxable(expected(s)));
      const from = firstSlip > `${y}-01` ? Number(firstSlip.slice(5)) : 1;
      const missing = Math.max(0, 12 - from + 1 - ys.length);
      const annual = p.annual_commission_override != null ? p.annual_commission_override : ys.reduce((a, b) => a + b, 0) + missing * avg;
      yearRate[y] = { annual, rate: commissionTaxRate(annual, p) };
    });
  }
  const netPay = (P, gross) => (p ? benefit(gross) + taxable(gross) * (1 - (yearRate[P.slice(0, 4)] || Object.values(yearRate).pop()).rate) : gross);
  slips.forEach((s) => { s.net = netPay(s.P, s.gross); s.netF = netPay(s.P, s.grossF); });
  const slipOf = Object.fromEntries(slips.map((s) => [s.P, s]));
  const now = slipOf[addM(cur, lag)] || slot(addM(cur, lag));
  const yr = p && (yearRate[cur.slice(0, 4)] || Object.values(yearRate).pop());
  const pc = (v) => `${Math.round(v * 100)}%`;
  const partsText = (parts) => Object.entries(parts).filter(([, v]) => v > 0.5).sort().map(([m, v]) => `${eur.format(v)} da ${monthLabel(m)}`).join(' + ') || 'nessuna';

  document.getElementById('commHint').innerHTML =
    `Da contratto: base di calcolo = valore annuo dei nuovi contratti firmati nel mese (i rinnovi contano al 50%; in HubSpot non sono distinti, quindi qui tutto conta come nuovo). Le commissioni scattano al <b>${pc(c.threshold_pct)} della quota</b> del mese; poi <b>${pc(c.base_rate)} fino alla quota</b>, <b>${pc(c.quota_rate)} sulla parte oltre la quota fino a ${eur.format(c.upper_from)}</b>, <b>${pc(c.upper_rate)} oltre ${eur.format(c.upper_from)}</b>. <b>Maturano sul contrattato</b> del mese di firma e <b>si erogano quando il cliente paga</b>: ogni deal porta la sua quota della commissione del mese (in proporzione all'importo) e la versa nelle buste dei mesi di incasso, secondo il piano impostato sotto. La busta del mese si paga la prima settimana del mese successivo. Il previsto usa chiuso + pipeline pesata, che si assume incassata alla firma.` +
    (p ? ` Fisso mensile ${eur.format(salary)} = ${eur.format(fixedNet)} netti + ${eur.format(meal)} di buoni pasto esenti. <b>Netto commissioni stimato</b> (ipotesi ${p.hypothesis}: ${p.hypotheses[p.hypothesis].label}): i primi <b>${eur.format(p.commission_benefit_monthly || 0)}</b> di commissione in ogni busta arrivano come benefit esenti, quindi netti. Sul resto l'IRPEF si calcola sul reddito dell'anno: la parte tassata delle commissioni in busta nel ${cur.slice(0, 4)} (≈ ${eur.format(yr.annual)} lordi) paga in media il <b>${pct(yr.rate)}</b> tra contributi INPS, IRPEF e addizionali (queste trattenute l'anno dopo). È una stima: va verificata sulla busta paga.` : ` Stipendio netto fisso ${eur.format(c.net_salary)} al mese.`);

  let next = '', nextVal = '—', nextLabel = 'Prossimo scaglione';
  if (!r.target) next = 'Target del mese non impostato';
  else if (r.closed < r.threshold) {
    nextLabel = 'Mancano alla soglia'; nextVal = eur.format(r.threshold - r.closed);
    next = `Soglia del ${pc(c.threshold_pct)} della quota: ${eur.format(r.threshold)}. A soglia la commissione vale ${eur.format(commissionFor(r.threshold, r.target))}`;
  } else if (r.closed < r.target) {
    nextLabel = 'Mancano alla quota'; nextVal = eur.format(r.target - r.closed);
    next = `Ogni 1.000 € in più vale ${eur.format(1000 * c.base_rate)}; oltre la quota di ${eur.format(r.target)} vale ${eur.format(1000 * c.quota_rate)}`;
  } else if (r.closed < c.upper_from) {
    nextLabel = `Mancano allo scaglione ${pc(c.upper_rate)}`; nextVal = eur.format(c.upper_from - r.closed);
    next = `Oltre la quota: ogni 1.000 € in più vale ${eur.format(1000 * c.quota_rate)}; oltre ${eur.format(c.upper_from)} vale ${eur.format(1000 * c.upper_rate)}`;
  } else {
    nextLabel = 'Scaglione massimo'; nextVal = pc(c.upper_rate);
    next = `Oltre ${eur.format(c.upper_from)}: ogni 1.000 € in più vale ${eur.format(1000 * c.upper_rate)}`;
  }
  const pending = slips.reduce((t, s) => t + s.pend, 0);
  const pendSlips = slips.filter((s) => s.pend > 0.5);
  let t = '';
  t += tile(`Commissione maturata ${monthLabel(r.m)} (sul contrattato)`, eur.format(r.comm), '',
    `Venduto ${eur.format(r.closed)}${r.target ? ` = ${pct(r.closed / r.target)} della quota ${eur.format(r.target)}` : ''} · ${eur.format(r.paidNow)} in busta di ${monthLabel(addM(r.m, lag))}${r.deferred > 0.5 ? `, <b>${eur.format(r.deferred)} nelle buste successive</b>` : ''}`,
    r.target ? `<div class="bar"><span style="width:${Math.min(100, (r.closed / r.target) * 100)}%"></span></div>` : '');
  t += tile(nextLabel, nextVal, '', next);
  t += tile(`Busta di ${monthLabel(now.P)}: erogato finora`, eur.format(salary + now.net), '',
    `Pagata a inizio ${paidOn(now.P)}: ${eur.format(fixedNet)} netti + ${eur.format(meal)} buoni pasto + ${eur.format(now.net)} netti di commissioni (${eur.format(now.gross)} lordi: ${partsText(now.parts)})`);
  t += tile(`Busta di ${monthLabel(now.P)}: previsto`, eur.format(salary + now.netF), '',
    `Se ${monthLabel(r.m)} chiude a ${eur.format(r.forecast)}: ${eur.format(now.grossF)} lordi ≈ ${eur.format(now.netF)} netti (${partsText(now.partsF)})`);
  t += tile('Già maturate, da incassare', eur.format(pending + unplanned), '',
    (pendSlips.length ? pendSlips.map((s) => `busta di ${monthLabel(s.P)}: ${eur.format(s.pend)}`).join(' · ') + ' (lordi, rate di contratti firmati)' : 'Nessuna rata in attesa')
    + (unplanned > 0.5 ? ` · <b>${eur.format(unplanned)} con data da confermare</b>` : '')
    + (overdue ? ` · <b>${overdue} ${overdue === 1 ? 'rata scaduta' : 'rate scadute'}</b>: segna se incassate` : ''));
  document.getElementById('tilesComm').innerHTML = t;

  let h = `<thead><tr><th>Mese di firma</th><th class="n">Quota</th><th class="n">Soglia ${pc(c.threshold_pct)}</th><th class="n">Contrattato</th><th class="n">% quota</th><th class="n">Commissione maturata</th><th class="n">In busta dello stesso mese</th><th class="n">Nelle buste successive</th><th class="n">Contrattato previsto</th><th class="n">Commissione prevista</th></tr></thead><tbody>`;
  rows.forEach((x) => {
    const future = x.m >= cur;
    h += `<tr class="${x.m === cur ? 'current' : ''}"><td>${monthLabel(x.m)}${x.m === cur ? ' (corrente)' : ''}</td>
      <td class="n">${x.target ? eur.format(x.target) : '—'}</td><td class="n">${x.threshold ? eur.format(x.threshold) : '—'}</td>
      <td class="n">${eur.format(x.closed)}</td><td class="n">${x.target ? pct(x.closed / x.target) : '—'}</td>
      <td class="n"><b>${eur.format(x.comm)}</b></td><td class="n">${eur.format(x.paidNow)}</td><td class="n">${x.deferred > 0.5 ? eur.format(x.deferred) : '—'}</td>
      <td class="n">${future ? eur.format(x.forecast) : '—'}</td><td class="n">${future ? eur.format(x.commF) : '—'}</td></tr>`;
  });
  document.getElementById('commTable').innerHTML = h + '</tbody>';

  h = `<thead><tr><th>Busta</th><th>Pagata a inizio</th><th>Commissioni erogate (per mese di firma)</th><th class="n">Lorde</th><th class="n">Nette</th><th class="n">Busta totale</th><th class="n">Previste lorde / nette</th><th class="n">Busta prevista</th></tr></thead><tbody>`;
  slips.forEach((s) => {
    const future = s.P >= addM(cur, lag);
    h += `<tr class="${s.P === now.P ? 'current' : ''}"><td>${monthLabel(s.P)}${s.P === now.P ? ' (corrente)' : ''}</td><td>${paidOn(s.P)}</td>
      <td class="name">${partsText(s.parts)}${future && Math.abs(s.grossF - s.gross) > 0.5 ? ` <span class="muted">· previste: ${partsText(s.partsF)}</span>` : ''}</td>
      <td class="n">${eur.format(s.gross)}</td><td class="n"><b>${eur.format(s.net)}</b></td><td class="n">${eur.format(salary + s.net)}</td>
      <td class="n">${future ? `${eur.format(s.grossF)} / ${eur.format(s.netF)}` : '—'}</td><td class="n">${future ? eur.format(salary + s.netF) : '—'}</td></tr>`;
  });
  document.getElementById('slipTable').innerHTML = h + '</tbody>';

  renderPaymentPlans(alloc, lag);
  renderSimulator({ rows, cur, c, salary, lag, slipOf, slot, netPay });
}

function renderPaymentPlans(alloc, lag) {
  const el = document.getElementById('payPlans');
  if (!el) return;
  const canEdit = !state.db || state.owner !== false;
  const dis = canEdit ? '' : ' disabled';
  const insText = (ins) => (ins.date ? `${dLabel(ins.date)} ${ins.date.slice(2, 4)}` : 'data da confermare');
  let h = `<thead><tr><th>Deal</th><th>Firmato</th><th class="n">Importo</th><th class="n">Commissione maturata</th><th>Piano di incasso</th><th>Rate</th></tr></thead><tbody>`;
  alloc.forEach((a) => {
    const pl = a.plan, tot = pl.installments.reduce((s, i) => s + (Number(i.amount) || 0), 0), left = a.d.amount - tot;
    const paid = pl.installments.filter((i) => i.status === 'paid').reduce((s, i) => s + (Number(i.amount) || 0), 0);
    // Rate chiuse di default: si apre solo il deal che si vuole modificare (resta aperto mentre lo si modifica)
    const open = state.openPlans?.has(String(a.d.id));
    const tbd = pl.installments.filter((i) => !i.date).length;
    const late = pl.installments.filter((i) => i.date && i.status !== 'paid' && i.date < state.asOf).length;
    h += `<tr data-id="${esc(a.d.id)}"><td class="name"><a href="${HUBSPOT_URL(a.d.id)}" target="_blank" rel="noopener">${esc(a.d.name)}</a></td>
      <td>${dLabel(a.d.closedate)}</td><td class="n">${eur.format(a.d.amount)}</td><td class="n">${eur.format(a.gross)}</td>
      <td><select data-plan${dis}>${Object.entries(PLAN_LABELS).map(([k, v]) => `<option value="${k}"${pl.plan === k ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
      <td class="muted"><button class="pay-toggle" data-toggle aria-expanded="${open ? 'true' : 'false'}">${open ? '▾' : '▸'} ${pl.installments.length} ${pl.installments.length === 1 ? 'rata' : 'rate'}</button> incassato ${eur.format(paid)} su ${eur.format(a.d.amount)}${Math.abs(left) > 0.5 ? ` <span class="flag">${left > 0 ? `${eur.format(left)} senza rata` : `rate oltre l'importo di ${eur.format(-left)}`}</span>` : ''}${tbd ? ` <span class="flag">${tbd} da confermare</span>` : ''}${late ? ` <span class="flag crit">${late} scadut${late === 1 ? 'a' : 'e'}</span>` : ''}${pl.saved ? '' : ' · <span class="muted">predefinito</span>'}${state.payments?.[a.d.id]?.note ? `<br>${esc(state.payments[a.d.id].note)}` : ''}</td></tr>
      <tr class="pay-lines" data-for="${esc(a.d.id)}"${open ? '' : ' hidden'}><td colspan="6"><div class="pay-grid">
      ${pl.installments.map((ins, k) => `<div class="pay-line" data-k="${k}">
        <b class="pay-k">${pl.installments.length === 1 ? 'Rata unica' : k === 0 ? 'Acconto' : `Rata ${k + 1}`}</b>
        <label>Data <input type="date" data-l="date" value="${esc(ins.date || '')}"${dis}></label>
        <label>Importo € <input type="number" data-l="amount" min="0" step="1" value="${ins.amount}"${dis}></label>
        <select data-l="status"${dis}><option value="paid"${ins.status === 'paid' ? ' selected' : ''}>Incassata</option><option value="expected"${ins.status !== 'paid' ? ' selected' : ''}>Da incassare</option></select>
        <span class="muted">≈ ${eur.format(a.d.amount ? (a.gross * (Number(ins.amount) || 0)) / a.d.amount : 0)} di commissione${ins.date ? ` · busta di ${monthLabel(D.month(D.addMonths(`${D.month(ins.date)}-01`, lag)))}` : ''}</span>
        ${!ins.date ? '<span class="flag">data da confermare</span>' : ins.status !== 'paid' && ins.date < state.asOf ? '<span class="flag crit">scaduta: incassata?</span>' : ''}
        ${canEdit ? '<button data-del aria-label="Rimuovi rata">×</button>' : ''}</div>`).join('')}
      ${canEdit ? '<button data-add>+ Aggiungi rata</button>' : ''}</div></td></tr>`;
  });
  el.querySelector('table').innerHTML = h + '</tbody>';
  const msg = el.querySelector('#payMsg');
  if (!canEdit) msg.textContent = 'Solo il proprietario della dashboard può modificare i piani di incasso.';
  const persist = async (id, plan) => {
    try {
      const where = await savePayment(id, plan);
      render();
      document.getElementById('payMsg').textContent = where === 'db' ? 'Piano di incasso salvato.' : 'Piano di incasso salvato in questo browser.';
    } catch (e) {
      document.getElementById('payMsg').textContent = `Non salvato (${e?.code || 'errore'}): riprova`;
    }
  };
  const byId = Object.fromEntries(alloc.map((a) => [String(a.d.id), a]));
  el.querySelectorAll('[data-toggle]').forEach((bt) => bt.addEventListener('click', () => {
    const id = bt.closest('tr').dataset.id;
    state.openPlans ||= new Set();
    if (state.openPlans.has(id)) state.openPlans.delete(id); else state.openPlans.add(id);
    const open = state.openPlans.has(id);
    el.querySelector(`tr.pay-lines[data-for="${CSS.escape(id)}"]`).hidden = !open;
    bt.setAttribute('aria-expanded', String(open));
    bt.textContent = bt.textContent.replace(/^[▸▾]/, open ? '▾' : '▸');
  }));
  // Cambio di piano: rigenera le rate dal modello (le date restano poi modificabili a mano).
  // Personalizzato parte dalle rate attuali, così si corregge solo quello che è cambiato.
  el.querySelectorAll('tbody tr[data-id] select[data-plan]').forEach((sel) => sel.addEventListener('change', () => {
    const a = byId[sel.closest('tr').dataset.id];
    const installments = sel.value === 'custom' ? a.plan.installments : buildInstallments(sel.value, a.d);
    (state.openPlans ||= new Set()).add(String(a.d.id)); // dopo il cambio di piano mostra le rate generate
    persist(a.d.id, { plan: sel.value, installments });
  }));
  el.querySelectorAll('tbody tr.pay-lines').forEach((tr) => {
    const a = byId[tr.dataset.for];
    const read = () => [...tr.querySelectorAll('.pay-line')].map((row) => ({
      amount: Number(row.querySelector('[data-l=amount]').value) || 0,
      date: row.querySelector('[data-l=date]').value || '',
      status: row.querySelector('[data-l=status]').value,
    }));
    // Una modifica a mano (data, importo, stato) aggiorna solo le rate: il piano resta quello scelto
    tr.querySelectorAll('.pay-line input, .pay-line select').forEach((inp) => inp.addEventListener('change', () => persist(a.d.id, { plan: a.plan.plan, installments: read() })));
    tr.querySelectorAll('[data-del]').forEach((bt) => bt.addEventListener('click', () => {
      const k = Number(bt.closest('.pay-line').dataset.k);
      persist(a.d.id, { plan: 'custom', installments: read().filter((_, j) => j !== k) });
    }));
    tr.querySelector('[data-add]')?.addEventListener('click', () => {
      const cur = read(), last = cur.filter((i) => i.date).pop()?.date;
      const left = Math.max(0, a.d.amount - cur.reduce((s, i) => s + i.amount, 0));
      persist(a.d.id, { plan: 'custom', installments: [...cur, { amount: Math.round(left), date: last ? addMonthsDay(last, 1) : '', status: 'expected' }] });
    });
  });
}

/* ---------- Simulatore: vendite stimate con probabilità di chiusura -> commissione e busta del mese ---------- */
// Le righe restano solo in questo browser (bozza personale, non condivisa con chi ha il link).
const SIM_KEY = 'kpi-commission-sim';
function simLoad() {
  try { return JSON.parse(localStorage.getItem(SIM_KEY) || 'null') || {}; } catch (e) { return {}; }
}
function simSave(sim) {
  try { localStorage.setItem(SIM_KEY, JSON.stringify(sim)); } catch (e) { /* storage non disponibile: la simulazione vale per questa visita */ }
}

function renderSimulator(model) {
  const { rows, cur, c, salary, lag, slot, netPay } = model;
  const el = document.getElementById('sim');
  if (!el) return;
  if (!state.sim) state.sim = { base: 'closed', items: [], ...simLoad() };
  const sim = state.sim;
  const months = rows.filter((x) => x.m >= cur);
  if (!months.length) { el.innerHTML = ''; return; }
  if (!months.some((x) => x.m === sim.month)) sim.month = months[0].m;
  const nextId = () => Math.max(0, ...sim.items.map((i) => i.id)) + 1;
  if (!sim.items.length) sim.items.push({ id: 1, name: '', amount: '', prob: 50 });

  const pc = (v) => `${Math.round(v * 100)}%`;
  el.innerHTML = `<div class="bridge-head"><h3>Simulatore vendite</h3>
      <div class="filters">
        <label class="muted">Mese <select id="simMonth">${months.map((x) => `<option value="${x.m}"${x.m === sim.month ? ' selected' : ''}>${monthLabel(x.m)}</option>`).join('')}</select></label>
        <div class="seg" id="simBase"><button data-v="closed"${sim.base === 'closed' ? ' class="on"' : ''}>Parti dal chiuso</button><button data-v="forecast"${sim.base === 'forecast' ? ' class="on"' : ''}>Chiuso + pipeline pesata</button></div>
      </div></div>
    <p class="hint">Aggiungi le vendite che pensi di chiudere nel mese, con la tua stima di chiudibilità: ogni vendita conta per importo × probabilità e si assume incassata alla firma. <b>Parti dal chiuso</b> somma le tue stime al venduto già firmato; <b>Chiuso + pipeline pesata</b> le somma anche al previsto da HubSpot (attenzione a non contare due volte un deal già in pipeline). Le righe restano salvate solo in questo browser.</p>
    <div class="table-wrap"><table id="simTable"><thead><tr><th>Vendita</th><th class="n">Importo annuo €</th><th class="n">Chiudibilità %</th><th class="n">Valore pesato</th><th></th></tr></thead><tbody>
      ${sim.items.map((i) => `<tr data-id="${i.id}"><td><input type="text" data-f="name" value="${esc(i.name)}" placeholder="Es. Studio Rossi"></td>
        <td class="n"><input type="number" data-f="amount" min="0" step="100" value="${i.amount}" placeholder="1788"></td>
        <td class="n"><input type="number" data-f="prob" min="0" max="100" step="5" value="${i.prob}"></td>
        <td class="n" data-w></td><td><button data-del aria-label="Rimuovi">×</button></td></tr>`).join('')}
    </tbody><tfoot><tr><th><button id="simAdd">+ Aggiungi vendita</button></th><th class="n" id="simTotAmount"></th><th></th><th class="n" id="simTotW"></th><th></th></tr></tfoot></table></div>
    <div class="tiles" id="simTiles" style="margin-top:12px"></div>`;

  const update = () => {
    simSave(sim);
    const x = rows.find((r) => r.m === sim.month);
    const base = sim.base === 'forecast' ? x.forecast : x.closed;
    const val = (i) => Number(i.amount) || 0;
    const w = (i) => val(i) * Math.min(100, Math.max(0, Number(i.prob) || 0)) / 100;
    el.querySelectorAll('#simTable tbody tr').forEach((tr) => {
      const i = sim.items.find((it) => it.id === Number(tr.dataset.id));
      tr.querySelector('[data-w]').textContent = eur.format(w(i));
    });
    const added = sim.items.reduce((s, i) => s + w(i), 0), full = sim.items.reduce((s, i) => s + val(i), 0);
    el.querySelector('#simTotAmount').textContent = eur.format(full);
    el.querySelector('#simTotW').textContent = eur.format(added);
    // Le vendite simulate si assumono incassate alla firma: la commissione in più entra nella busta del mese
    const P = D.month(D.addMonths(`${x.m}-01`, lag));
    const slipBase = sim.base === 'forecast' ? slot(P).grossF : slot(P).gross;
    const baseComm = commissionFor(base, x.target);
    const scen = (sales) => {
      const gross = commissionFor(sales, x.target), slipGross = slipBase + gross - baseComm;
      return { sales, gross, slipGross, net: netPay(P, slipGross) };
    };
    const b = scen(base), s = scen(base + added), all = scen(base + full);
    const plus = (v) => (v > 0.5 ? `<span class="up">+${eur.format(v)}</span>` : v < -0.5 ? `<span class="down">${eur.format(v)}</span>` : '<span class="flat">+0 €</span>');
    let band = '';
    if (x.target) {
      const v = s.sales;
      if (v < x.threshold) band = `Mancano ${eur.format(x.threshold - v)} alla soglia del ${pc(c.threshold_pct)} (${eur.format(x.threshold)})`;
      else if (v < x.target) band = `Mancano ${eur.format(x.target - v)} alla quota: oltre, ogni 1.000 € vale ${eur.format(1000 * c.quota_rate)}`;
      else if (v < c.upper_from) band = `Mancano ${eur.format(c.upper_from - v)} allo scaglione del ${pc(c.upper_rate)}`;
      else band = `Nello scaglione del ${pc(c.upper_rate)}: ogni 1.000 € in più vale ${eur.format(1000 * c.upper_rate)}`;
    }
    const pay = `busta di ${monthLabel(P)} (pagata a inizio ${monthLabel(D.month(D.addMonths(`${P}-01`, 1)))})`;
    let t = '';
    t += tile(`Venduto simulato ${monthLabel(x.m)}`, eur.format(s.sales), plus(added) + ' dalle tue stime',
      `${sim.base === 'forecast' ? 'Previsto' : 'Chiuso'} ${eur.format(base)}${x.target ? ` · ${pct(s.sales / x.target)} della quota ${eur.format(x.target)}` : ''}${band ? ` · ${band}` : ''}`,
      x.target ? `<div class="bar"><span style="width:${Math.min(100, (s.sales / x.target) * 100)}%"></span></div>` : '');
    t += tile(`Commissione maturata ${monthLabel(x.m)} simulata`, eur.format(s.gross), plus(s.gross - b.gross), `Sul contrattato del mese · senza le tue stime: ${eur.format(b.gross)}`);
    t += tile(`Commissioni nette in busta di ${monthLabel(P)}`, eur.format(s.net), plus(s.net - b.net),
      `${eur.format(s.slipGross)} lordi, comprese le rate di contratti precedenti · senza le tue stime: ${eur.format(b.net)} netti`);
    t += tile(`Busta di ${monthLabel(P)} simulata`, eur.format(salary + s.net), plus(s.net - b.net), `Netto in ${pay}`);
    t += tile('Se chiudono tutte (100%)', eur.format(salary + all.net), plus(all.net - b.net),
      `Venduto ${eur.format(all.sales)} · commissione ${eur.format(all.gross)} lordi ≈ ${eur.format(all.net)} netti`);
    el.querySelector('#simTiles').innerHTML = t;
  };

  el.querySelector('#simMonth').addEventListener('change', (e) => { sim.month = e.target.value; renderSimulator(model); });
  el.querySelectorAll('#simBase button').forEach((bt) => bt.addEventListener('click', () => { sim.base = bt.dataset.v; renderSimulator(model); }));
  el.querySelector('#simAdd').addEventListener('click', () => { sim.items.push({ id: nextId(), name: '', amount: '', prob: 50 }); renderSimulator(model); });
  el.querySelectorAll('#simTable tbody tr').forEach((tr) => {
    const i = sim.items.find((it) => it.id === Number(tr.dataset.id));
    tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => { i[inp.dataset.f] = inp.value; update(); }));
    tr.querySelector('[data-del]').addEventListener('click', () => { sim.items = sim.items.filter((it) => it !== i); renderSimulator(model); });
  });
  update();
}

/* ---------- Funnel per fase (coorte delle demo) ---------- */
// HubSpot non conserva lo storico delle fasi: la fase più avanzata raggiunta si ricava dalla fase attuale
// e, per i deal persi, dagli eventi in calendario (un'attivazione o una valutazione dimostrano il passaggio).
const FUNNEL = [
  { key: 'fissata', label: 'Demo fissata' },
  { key: 'svolta', label: 'Demo svolta' },
  { key: 'setup', label: 'Attivazione (Trial Setup)' },
  { key: 'live', label: 'Prova attiva (Trial Live)' },
  { key: 'nego', label: 'Valutazione / Negotiation' },
  { key: 'won', label: 'Vinto' },
];
function funnelLevel(d, today) {
  if (isWon(d)) return 5;
  const ev = d.evaluation_date && d.evaluation_date <= today;
  const act = !!d.activation_date;
  switch (d.stage) {
    case STAGE.NEGOTIATION: return 4;
    case STAGE.TRIAL_LIVE: return ev ? 4 : 3;
    case STAGE.TRIAL_SETUP: return ev ? 4 : 2;
    case STAGE.SHOW_UP: return act ? 2 : 1; // attivazione già in calendario
    case STAGE.DEMO_SCHEDULED: return 1; // demo passata senza esito registrato: conta come svolta
    case STAGE.NO_SHOW: return 0;
    default: return ev ? 4 : act ? 2 : 1; // perso / riattivazione: la demo c'è stata
  }
}
function funnelFor(deals, r, today) {
  const cohort = deals.filter((d) => d.demo_date && inRange(d.demo_date, r) && d.demo_date <= today);
  const rows = FUNNEL.map((f) => ({ ...f, reached: 0, open: 0, lost: 0 }));
  cohort.forEach((d) => {
    const lv = funnelLevel(d, today);
    for (let i = 0; i <= lv; i++) rows[i].reached++;
    if (lv < 5) (isOpen(d) ? rows[lv].open++ : rows[lv].lost++);
  });
  rows.forEach((row, i) => {
    if (!i) return;
    const prev = rows[i - 1];
    row.rate = prev.reached ? row.reached / prev.reached : null;
    // Sui casi chiusi: esclude chi è ancora fermo alla fase precedente in attesa di esito
    const decided = prev.reached - prev.open;
    row.rateDecided = decided ? row.reached / decided : null;
    row.decided = decided;
  });
  return rows;
}
function renderFunnel(latest) {
  const fp = funnelFor(latest.deals, state.a, state.asOf);
  const fs = funnelFor(latest.deals, { from: analysisStart(), to: state.asOf }, state.asOf);
  // Collo di bottiglia: il passaggio con il tasso più basso sui casi chiusi (da settembre, almeno 5 casi)
  const cand = fs.slice(2).filter((r) => r.rateDecided != null && r.decided >= 5);
  const neck = cand.length ? cand.reduce((a, b) => (b.rateDecided < a.rateDecided ? b : a)).key : null;
  const bar = (v) => (v == null ? '' : `<div class="bar" style="width:80px;margin:4px 0 0 auto"><span style="width:${Math.min(100, v * 100)}%"></span></div>`);
  const since = monthLabel(D.month(analysisStart()));
  let h = `<thead><tr><th>Fase</th><th class="n">Periodo · deal</th><th class="n">Periodo · passaggio</th><th class="n">Da ${since} · deal</th><th class="n">Da ${since} · passaggio</th><th class="n">Passaggio sui casi chiusi</th><th class="n">Fermi qui ora</th><th class="n">Persi qui</th></tr></thead><tbody>`;
  fs.forEach((row, i) => {
    const p = fp[i];
    const flag = row.key === neck ? ' <span class="flag crit">collo di bottiglia</span>' : '';
    h += `<tr><td>${i ? '→ ' : ''}${row.label}${flag}</td>
      <td class="n">${p.reached}</td><td class="n">${i ? pct(p.rate) : '—'}</td>
      <td class="n"><b>${row.reached}</b></td><td class="n">${i ? pct(row.rate) + bar(row.rate) : '—'}</td>
      <td class="n">${i ? `${pct(row.rateDecided)} <span class="muted">(${row.decided})</span>` : '—'}</td>
      <td class="n">${row.key === 'won' ? '—' : row.open || '—'}</td><td class="n">${row.key === 'won' ? '—' : row.lost || '—'}</td></tr>`;
  });
  const total = (rows) => (rows[0].reached ? rows[5].reached / rows[0].reached : null);
  const held = (rows) => (rows[1].reached ? rows[5].reached / rows[1].reached : null);
  const setup = (rows) => (rows[2].reached ? rows[5].reached / rows[2].reached : null);
  h += `</tbody><tfoot><tr><th>Demo svolta → vinto</th><td class="n">${pct(held(fp))}</td><td></td><td class="n"><b>${pct(held(fs))}</b></td><td colspan="4"></td></tr>
    <tr><th>Attivazione → vinto</th><td class="n">${pct(setup(fp))}</td><td></td><td class="n"><b>${pct(setup(fs))}</b></td><td colspan="4"></td></tr>
    <tr><th>Demo fissata → vinto</th><td class="n">${pct(total(fp))}</td><td></td><td class="n"><b>${pct(total(fs))}</b></td><td colspan="4"></td></tr></tfoot>`;
  document.getElementById('funnel').innerHTML = h;
}

/* ---------- Bridge: deal che compongono il chiuso del mese (da ottobre 2026) ---------- */
const BRIDGE_FROM = '2026-10';
function renderBridge(latest) {
  const cur = D.month(state.asOf);
  const months = [];
  for (let m = BRIDGE_FROM + '-01'; D.month(m) <= D.month(D.addMonths(state.asOf, 2)); m = D.addMonths(m, 1)) months.push(D.month(m));
  if (!state.bridgeMonth || !months.includes(state.bridgeMonth)) state.bridgeMonth = months.includes(cur) ? cur : months[0];
  const m = state.bridgeMonth;
  const mEl = document.getElementById('bridgeMonths');
  mEl.innerHTML = months.map((k) => `<button data-m="${k}" class="${k === m ? 'on' : ''}">${monthLabel(k)}${k === cur ? ' ·' : ''}</button>`).join('');
  mEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.bridgeMonth = b.dataset.m; renderBridge(latest); }));

  const won = latest.deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m)
    .sort((a, b) => a.closedate.localeCompare(b.closedate) || b.amount - a.amount);
  const open = latest.deals.filter((d) => isOpen(d) && d.incasso && D.month(d.incasso) === m)
    .sort((a, b) => a.incasso.localeCompare(b.incasso) || b.weighted - a.weighted);
  const closed = won.reduce((s, d) => s + d.amount, 0);
  const weighted = open.reduce((s, d) => s + d.weighted, 0);
  const target = targetOf(m);
  const ref = target || closed + weighted || 1;
  const cumCell = (v) => `<div class="cum"><span>${eur.format(v)}</span><div class="bar"><span style="width:${Math.min(100, (v / ref) * 100)}%"></span></div></div>`;
  const link = (d) => `<a href="${HUBSPOT_URL(d.id)}" target="_blank" rel="noopener">${esc(d.name)}</a>`;

  document.getElementById('bridgeHint').innerHTML =
    `Ogni deal Closed Won / Closed Won Paid con closedate a <b>${monthLabel(m)}</b>, in ordine di chiusura, con il cumulato che arriva al chiuso del mese. Sotto, i deal aperti che incassano nello stesso mese portano dal chiuso al previsto (importo × probabilità). La barra misura il cumulato ${target ? 'sul target' : 'sul previsto (target non impostato)'}.`;

  let h = `<thead><tr><th>#</th><th>Deal</th><th>Status</th><th>Closed date</th><th class="n">Valore</th><th class="n">Prob.</th><th class="n">Contributo</th><th class="n">% del chiuso</th><th class="n">Cumulato</th></tr></thead><tbody>`;
  h += `<tr class="sep"><td colspan="9">Chiuso · ${won.length} deal</td></tr>`;
  let cum = 0;
  if (!won.length) h += `<tr><td></td><td colspan="8" class="muted">Nessun deal chiuso con closedate a ${monthLabel(m)}.</td></tr>`;
  won.forEach((d, i) => {
    cum += d.amount;
    h += `<tr><td class="idx">${i + 1}</td><td class="name">${link(d)}</td><td>${esc(d.info.label)}</td><td>${dLabel(d.closedate)}</td>
      <td class="n">${eur.format(d.amount)}</td><td class="n">100%</td><td class="n">${eur.format(d.amount)}</td><td class="n">${closed ? pct(d.amount / closed) : '—'}</td><td class="n">${cumCell(cum)}</td></tr>`;
  });
  h += `<tr class="sub"><td></td><td>Totale chiuso ${monthLabel(m)}</td><td></td><td></td><td class="n">${eur.format(closed)}</td><td></td><td class="n">${eur.format(closed)}</td><td class="n">${closed ? '100%' : '—'}</td><td class="n">${cumCell(closed)}</td></tr>`;
  if (target != null) {
    h += `<tr><td></td><td>Target ${monthLabel(m)}</td><td></td><td></td><td></td><td></td><td class="n">${eur.format(target)}</td><td></td><td class="n"><span class="${closed >= target ? 'up' : 'down'}">${closed >= target ? 'raggiunto' : `gap ${eur.format(target - closed)}`}</span></td></tr>`;
  }
  if (open.length) {
    h += `<tr class="sep"><td colspan="9">Da chiuso a previsto · ${open.length} deal aperti con incasso a ${monthLabel(m)}</td></tr>`;
    let c2 = closed;
    open.forEach((d, i) => {
      c2 += d.weighted;
      h += `<tr><td class="idx">${won.length + i + 1}</td><td class="name">${link(d)}</td><td>${esc(d.info.label)}</td><td>${dLabel(d.incasso)} <span class="muted">prevista</span></td>
        <td class="n">${eur.format(d.amount)}</td><td class="n">${pct(d.p)}</td><td class="n">${eur.format(d.weighted)}</td><td class="n muted">—</td><td class="n">${cumCell(c2)}</td></tr>`;
    });
    h += `<tr class="sub"><td></td><td>Previsto ${monthLabel(m)}</td><td></td><td></td><td class="n">${eur.format(closed + open.reduce((s, d) => s + d.amount, 0))} <span class="muted">best case</span></td><td></td><td class="n">${eur.format(closed + weighted)}</td><td></td><td class="n">${cumCell(closed + weighted)}</td></tr>`;
    if (target != null) h += `<tr><td></td><td class="muted">Gap previsto vs target</td><td colspan="6"></td><td class="n"><span class="${closed + weighted >= target ? 'up' : 'down'}">${eur.format(closed + weighted - target)}</span></td></tr>`;
  }
  document.getElementById('bridge').innerHTML = h + '</tbody>';
}

function renderForecast(latest) {
  const months = [0, 1, 2].map((i) => D.month(D.addMonths(state.asOf, i)));
  const targets = new Proxy({}, { get: (_, mm) => targetOf(mm) });
  let h = `<thead><tr><th>Mese di incasso</th><th class="n">Chiuso</th><th class="n">Pipeline pesata</th><th class="n">Previsto</th><th class="n">Target</th><th class="n">Gap previsto</th><th class="n">Best case</th><th class="n">Deal</th><th class="n">Rischio slittamento</th></tr></thead><tbody>`;
  months.forEach((m, i) => {
    const won = latest.deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m);
    const open = latest.deals.filter((d) => isOpen(d) && d.incasso && D.month(d.incasso) === m);
    const closed = won.reduce((s, d) => s + d.amount, 0);
    const w = open.reduce((s, d) => s + d.weighted, 0);
    const best = closed + open.reduce((s, d) => s + d.amount, 0);
    const t = targets[m];
    const lateIn = latest.deals.filter((d) => isOpen(d) && (d.exp?.late || d.exp?.lateRisk) && d.exp.evaluation && D.month(d.exp.evaluation) === m);
    h += `<tr class="click ${i === 0 ? 'current' : ''}" data-m="${m}"><td>${monthLabel(m)}${i === 0 ? ' (corrente)' : ''}</td>
      <td class="n">${eur.format(closed)}</td><td class="n">${eur.format(w)}</td><td class="n"><b>${eur.format(closed + w)}</b></td>
      <td class="n">${t != null ? eur.format(t) : '—'}</td>
      <td class="n">${t != null ? `<span class="${closed + w >= t ? 'up' : 'down'}">${eur.format(closed + w - t)}</span>` : '—'}</td>
      <td class="n">${eur.format(best)}</td><td class="n">${won.length} vinti · ${open.length} aperti</td>
      <td class="n">${lateIn.length ? `<span class="flag">${lateIn.length} valutaz. dopo il ${state.config.cycle.late_evaluation_day}</span> ${eur.format(lateIn.reduce((s, d) => s + d.amount, 0))} → ${monthLabel(D.month(D.addMonths(m + '-01', 1)))}` : '—'}</td></tr>`;
  });
  h += '</tbody>';
  const el = document.getElementById('forecast');
  el.innerHTML = h + `<caption class="muted" style="caption-side:bottom;text-align:left;padding-top:6px">Pesata = importo × probabilità per stage (config.json). Clic su un mese per filtrare i deal aperti.</caption>`;
  el.querySelectorAll('tr[data-m]').forEach((tr) => tr.addEventListener('click', () => {
    state.dealFilter = tr.dataset.m; renderDeals(latest);
    document.getElementById('deals').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function renderCohorts(latest) {
  const today = state.asOf;
  const first = D.max(D.month(D.addMonths(today, -5)), D.month(analysisStart()));
  const months = []; for (let m = first + '-01'; D.month(m) <= D.month(today); m = D.addMonths(m, 1)) months.push(D.month(m));
  const demos = latest.events.filter((e) => e.kind === 'demo' && e.date <= today);
  barChart(document.getElementById('chDemos'), months.map((m) => ({
    key: m, label: monthLabel(m), value: demos.filter((e) => D.month(e.date) === m).length,
  })), { highlight: D.month(today) });
  barChart(document.getElementById('chClosed'), months.map((m) => {
    const w = latest.deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m);
    return { key: m, label: monthLabel(m), value: w.reduce((s, d) => s + d.amount, 0), tip: `${w.length} deal` };
  }), { money: true, highlight: D.month(today) });

  // Tabella: coorte (mese demo) -> esiti e mese di incasso
  const rows = months.map((m) => {
    const c = latest.deals.filter((d) => D.month(d.cohort) === m && d.cohort <= today);
    const won = c.filter(isWon);
    const by = (k) => won.filter((d) => d.closedate && D.month(d.closedate) === D.month(D.addMonths(m + '-01', k))).reduce((s, d) => s + d.amount, 0);
    const later = won.filter((d) => d.closedate && D.month(d.closedate) > D.month(D.addMonths(m + '-01', 1))).reduce((s, d) => s + d.amount, 0);
    return { m, n: c.length, fromCal: c.filter((d) => d.demo_date_source === 'calendar').length,
      noshow: c.filter((d) => d.stage === STAGE.NO_SHOW).length,
      held: c.filter((d) => d.demo_date && d.stage !== STAGE.NO_SHOW && d.stage !== STAGE.DEMO_SCHEDULED).length,
      trial: c.filter((d) => d.demo_date && d.stage !== STAGE.NO_SHOW && d.stage !== STAGE.DEMO_SCHEDULED && (TRIAL_OR_LATER.has(d.stage) || d.activation_date)).length,
      open: c.filter(isOpen).length, won: won.length, lost: c.filter((d) => d.info.group === 'lost').length,
      m0: by(0), m1: by(1), later, pipeW: c.filter(isOpen).reduce((s, d) => s + d.weighted, 0) };
  });
  let h = `<thead><tr><th>Coorte (mese demo)</th><th class="n">Deal</th><th class="n">No-show</th><th class="n">Demo svolte</th><th class="n">→ Prova</th><th class="n">Demo → prova</th><th class="n">Vinti</th><th class="n">Persi</th><th class="n">Aperti</th><th class="n">Win rate</th><th class="n">Incassato stesso mese</th><th class="n">Incassato mese +1</th><th class="n">Incassato dopo</th><th class="n">Pipeline pesata residua</th></tr></thead><tbody>`;
  rows.forEach((r) => {
    h += `<tr><td>${monthLabel(r.m)} <span class="muted">(${r.fromCal} da calendario)</span></td><td class="n">${r.n}</td><td class="n">${r.noshow}</td><td class="n">${r.held}</td><td class="n">${r.trial}</td><td class="n">${r.held ? pct(r.trial / r.held) : '—'}</td><td class="n">${r.won}</td><td class="n">${r.lost}</td><td class="n">${r.open}</td>
      <td class="n">${r.won + r.lost ? pct(r.won / (r.won + r.lost)) : '—'}</td><td class="n">${eur.format(r.m0)}</td><td class="n">${eur.format(r.m1)}</td><td class="n">${eur.format(r.later)}</td><td class="n">${eur.format(r.pipeW)}</td></tr>`;
  });
  document.getElementById('cohorts').innerHTML = h + `</tbody><caption class="muted" style="caption-side:bottom;text-align:left;padding-top:6px">Mese demo = prima demo trovata in calendario; se assente, data di creazione del deal. Demo → prova solo sulle demo svolte trovate in calendario (esclusi no-show ed esiti non registrati). Win rate sui deal già decisi (vinti / vinti + persi).</caption>`;
}

function renderPipeline(latest) {
  const cmp = stockKpis(snapshotAt(state.b.to));
  const agg = (deals) => {
    const o = {};
    deals.forEach((d) => { const k = state.config.stages[d.stage] ? d.stage : 'unknown'; o[k] = o[k] || { n: 0, v: 0, w: 0 }; o[k].n++; o[k].v += d.amount; o[k].w += d.weighted; });
    return o;
  };
  const now = agg(latest.deals), before = cmp ? agg(cmp.deals) : null;
  document.getElementById('pipeHint').innerHTML = cmp
    ? `Confronto con lo snapshot del ${dLabel(cmp.date)} ${cmp.date.slice(0, 4)} (il più vicino a fine periodo di confronto).`
    : 'Nessuno snapshot disponibile per il periodo di confronto: i delta compariranno con gli aggiornamenti successivi.';
  const keys = Object.entries(state.config.stages).sort((a, b) => a[1].order - b[1].order).map(([k]) => k).concat(['unknown']);
  let h = `<thead><tr><th>Stage</th><th class="n">Deal</th><th class="n">Δ deal</th><th class="n">Valore</th><th class="n">Δ valore</th><th class="n">Prob.</th><th class="n">Pesato</th></tr></thead><tbody>`;
  keys.forEach((k) => {
    const a = now[k] || { n: 0, v: 0, w: 0 }, b = before ? before[k] || { n: 0, v: 0 } : null;
    if (!a.n && !(b && b.n)) return;
    const dn = b ? a.n - b.n : null, dv = b ? a.v - b.v : null;
    const sg = (x, f) => (x == null ? '—' : x === 0 ? '<span class="flat">0</span>' : `<span class="${x > 0 ? 'up' : 'down'}">${x > 0 ? '+' : ''}${f(x)}</span>`);
    h += `<tr><td>${esc(k === 'unknown' ? 'Stage non mappato' : state.config.stages[k].label)}</td><td class="n">${a.n}</td><td class="n">${sg(dn, num.format)}</td><td class="n">${eur.format(a.v)}</td><td class="n">${sg(dv, eur.format)}</td>
      <td class="n">${state.config.forecast_probability[k] != null ? pct(state.config.forecast_probability[k]) : '—'}</td><td class="n">${a.w ? eur.format(a.w) : '—'}</td></tr>`;
  });
  document.getElementById('pipeline').innerHTML = h + '</tbody>';
}

function renderTrend() {
  const dates = Object.keys(state.snaps).sort();
  const series = [
    { name: 'Pipeline aperta', color: 'var(--s1)', points: [] },
    { name: 'Previsto mese corrente (chiuso + pesato)', color: 'var(--s2)', points: [] },
    { name: 'Chiuso mese corrente', color: 'var(--s3)', points: [] },
  ];
  dates.forEach((d) => {
    const k = stockKpis(state.snaps[d]);
    series[0].points.push({ x: d, y: k.openValue });
    series[1].points.push({ x: d, y: k.forecastMonth });
    series[2].points.push({ x: d, y: k.closedMonth });
  });
  lineChart(document.getElementById('chTrend'), series);
}

function risksFor(latest) {
  const today = state.asOf, c = state.config.cycle, out = [];
  const add = (level, title, d, detail) => out.push({ level, title, d, detail });
  latest.deals.forEach((d) => {
    if (!isOpen(d)) {
      if (d.info.group === 'unknown') add('warning', 'Stage non mappato in config.json', d, `stage ${d.stage}`);
      return;
    }
    if (d.exp?.late) {
      const fixed = d.evaluation_date === d.exp.evaluation;
      add(fixed ? 'critical' : 'serious',
        `Valutazione ${fixed ? '' : 'stimata '}dopo il ${c.late_evaluation_day}: incassa a ${monthLabel(D.month(d.incasso))}`, d,
        `valutazione ${dLabel(d.exp.evaluation)} (${d.exp.basis}) · ${fixed ? 'anticipala' : 'fissa attivazione/valutazione in modo da chiudere entro il ' + c.late_evaluation_day} per incassare nel mese`);
    }
    if (d.exp?.lateRisk) add('critical', `Valutazione dopo il ${c.late_evaluation_day} con closedate a ${monthLabel(D.month(d.closedate))}`, d,
      `valutazione ${dLabel(d.exp.evaluation)}, closedate ${dLabel(d.closedate)}: rischio di incassare il mese dopo. Anticipa la valutazione o sposta la closedate`);
    if (d.closedate && d.closedate < today) add('serious', 'Closedate scaduta su deal aperto', d, `closedate ${dLabel(d.closedate)} (${d.info.label}): aggiornare la data o chiudere il deal. Uso una stima: ${d.exp?.basis || ''}`);
    if (!d.closedate && [STAGE.TRIAL_SETUP, STAGE.TRIAL_LIVE, STAGE.NEGOTIATION].includes(d.stage)) add('warning', 'Deal in prova senza closedate', d, `incasso stimato: ${d.exp?.basis || ''}`);
    if (d.stage === STAGE.TRIAL_LIVE && !(d.evaluation_date && d.evaluation_date >= today)) add('serious', 'Prova attiva senza valutazione in calendario', d, d.activation_date ? `attivata il ${dLabel(d.activation_date)}: fissare la valutazione` : 'fissare la valutazione risultati');
    if (d.stage === STAGE.TRIAL_SETUP && !(d.activation_date && d.activation_date >= today)) add('warning', 'Trial Setup senza attivazione futura in calendario', d, 'fissare la call di attivazione');
    if (d.stage === STAGE.DEMO_SCHEDULED && d.demo_date && d.demo_date < today) add('warning', 'Demo passata ma deal ancora in Demo Scheduled', d, `demo del ${dLabel(d.demo_date)}: aggiornare a show-up o no-show`);
    if (d.stage === STAGE.SHOW_UP && d.demo_date && D.diff(today, d.demo_date) > c.demo_to_activation_days) add('warning', `Demo fatta da oltre ${c.demo_to_activation_days} gg senza attivazione`, d, `demo del ${dLabel(d.demo_date)}`);
    if (d.stale > state.config.stale_days) add('warning', `Deal fermo da ${d.stale} gg`, d, `ultima modifica ${dLabel(d.lastmod)}`);
  });
  const order = { critical: 0, serious: 1, warning: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || b.d.amount - a.d.amount);
}

function renderRisks(latest) {
  const list = risksFor(latest);
  const label = { critical: '● Critico', serious: '▲ Alto', warning: '■ Attenzione' };
  document.getElementById('risks').innerHTML = list.length
    ? list.map((r) => `<li><span class="badge ${r.level}">${label[r.level]}</span><div><b>${esc(r.title)}</b> — <a href="${HUBSPOT_URL(r.d.id)}" target="_blank" rel="noopener">${esc(r.d.name)}</a> · ${eur.format(r.d.amount)}<div class="detail">${esc(r.detail)}</div></div></li>`).join('')
    : '<li>Nessun rischio rilevato.</li>';
}

function renderDeals(latest) {
  const months = [0, 1, 2].map((i) => D.month(D.addMonths(state.asOf, i)));
  const filters = [['all', 'Tutti'], ...months.map((m) => [m, `Incasso ${monthLabel(m)}`]), ['later', 'Più avanti']];
  const fEl = document.getElementById('dealFilters');
  fEl.innerHTML = filters.map(([k, l]) => `<button data-f="${k}" class="${state.dealFilter === k ? 'on' : ''}">${l}</button>`).join('');
  fEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.dealFilter = b.dataset.f; renderDeals(latest); }));
  let deals = latest.deals.filter(isOpen);
  if (state.dealFilter === 'later') deals = deals.filter((d) => d.incasso && D.month(d.incasso) > months[2]);
  else if (state.dealFilter !== 'all') deals = deals.filter((d) => d.incasso && D.month(d.incasso) === state.dealFilter);
  deals.sort((a, b) => (a.incasso || '9').localeCompare(b.incasso || '9') || b.info.order - a.info.order);
  const riskIds = new Set(risksFor(latest).filter((r) => r.level !== 'warning').map((r) => r.d.id));
  let h = `<thead><tr><th>Deal</th><th>Stage</th><th class="n">Importo</th><th class="n">Prob.</th><th class="n">Pesato</th><th>Demo</th><th>Attivazione</th><th>Valutazione</th><th>Incasso previsto</th><th>Base stima</th></tr></thead><tbody>`;
  deals.forEach((d) => {
    h += `<tr><td class="name"><a href="${HUBSPOT_URL(d.id)}" target="_blank" rel="noopener">${esc(d.name)}</a>${riskIds.has(d.id) ? '<span class="flag crit">rischio</span>' : ''}${d.stale > state.config.stale_days ? `<span class="flag">fermo ${d.stale} gg</span>` : ''}</td>
      <td>${esc(d.info.label)}</td><td class="n">${eur.format(d.amount)}</td><td class="n">${pct(d.p)}</td><td class="n">${eur.format(d.weighted)}</td>
      <td>${dLabel(d.demo_date)}</td><td>${dLabel(d.activation_date)}</td><td>${dLabel(d.evaluation_date)}</td>
      <td><b>${d.incasso ? monthLabel(D.month(d.incasso)) : '—'}</b> <span class="muted">${dLabel(d.incasso)}</span></td><td class="muted">${esc(d.exp?.basis || '')}</td></tr>`;
  });
  const tot = deals.reduce((s, d) => s + d.amount, 0), totW = deals.reduce((s, d) => s + d.weighted, 0);
  h += `</tbody><tfoot><tr><th>${deals.length} deal</th><th></th><th class="n">${eur.format(tot)}</th><th></th><th class="n">${eur.format(totW)}</th><th colspan="5"></th></tr></tfoot>`;
  document.getElementById('deals').innerHTML = h;
}

function renderQuality(latest) {
  const snap = state.snaps[state.asOf];
  const unmatched = latest.events.filter((e) => !e.deal_id && ['demo', 'attivazione', 'valutazione'].includes(e.kind) && e.date <= state.asOf)
    .sort((a, b) => b.date.localeCompare(a.date));
  const unknown = latest.deals.filter((d) => d.info.group === 'unknown');
  const noAmount = latest.deals.filter((d) => (isOpen(d) || isWon(d)) && !d.amount);
  const wonNoDate = latest.deals.filter((d) => isWon(d) && !d.closedate);
  let h = snap.source.calendar_stale ? '<p class="muted"><b>Calendar non raggiungibile:</b> date di demo, attivazioni e valutazioni prese dall\'ultimo snapshot salvato.</p>' : '';
  h += `<p class="muted">Fonte: HubSpot ${snap.source.hubspot_total} deal · Calendar ${snap.source.calendar_events} eventi (${dLabel(snap.source.calendar_range[0])} – ${dLabel(snap.source.calendar_range[1])}) · snapshot generato ${esc(snap.generated_at)}</p>`;
  if (wonNoDate.length) h += `<h3>Deal vinti senza closedate (${wonNoDate.length}) — esclusi dal chiuso</h3><ul>${wonNoDate.map((d) => `<li><a href="${HUBSPOT_URL(d.id)}" target="_blank" rel="noopener">${esc(d.name)}</a> · ${eur.format(d.amount)}</li>`).join('')}</ul>`;
  if (unknown.length) h += `<h3>Deal in stage non mappati (${unknown.length})</h3><ul>${unknown.map((d) => `<li><a href="${HUBSPOT_URL(d.id)}" target="_blank" rel="noopener">${esc(d.name)}</a> · stage ${esc(d.stage)}</li>`).join('')}</ul>`;
  if (noAmount.length) h += `<h3>Deal aperti/vinti senza importo (${noAmount.length})</h3><ul>${noAmount.map((d) => `<li>${esc(d.name)}</li>`).join('')}</ul>`;
  h += `<h3>Eventi demo/attivazione/valutazione senza deal HubSpot (${unmatched.length})</h3><ul>${unmatched.slice(0, 40).map((e) => `<li>${dLabel(e.date)} · ${esc(e.kind)} · ${esc(e.summary)}</li>`).join('')}</ul>`;
  document.getElementById('quality').innerHTML = h;
}

function renderTargetEditor() {
  const t = state.config.targets?.monthly || {};
  const months = [-2, -1, 0, 1, 2, 3].map((i) => D.month(D.addMonths(state.asOf, i)));
  const el = document.getElementById('targetEditor');
  el.innerHTML = `<div class="target-grid">${months.map((m) => `<label>${monthLabel(m)}<input type="number" min="0" step="100" data-m="${m}" value="${t[m] ?? ''}" placeholder="${targetOf(m) ?? '€'}"></label>`).join('')}</div>
    <div class="actions"><button id="saveTargets">Salva target</button><span class="muted" id="tMsg"></span></div>`;
  el.querySelector('#saveTargets').addEventListener('click', async () => {
    const monthly = { ...t };
    el.querySelectorAll('input[data-m]').forEach((i) => { if (i.value === '') delete monthly[i.dataset.m]; else monthly[i.dataset.m] = Number(i.value); });
    const msg = el.querySelector('#tMsg');
    if (state.db) {
      try {
        await state.db.doc('settings/targets').set({ monthly });
        state.config.targets = { ...state.config.targets, monthly };
        render();
        document.getElementById('tMsg').textContent = 'Salvato: lo vede chiunque apra la dashboard';
      } catch (e) {
        msg.textContent = e?.code === 'invalid_argument' ? 'Solo il proprietario della dashboard può modificare i target' : `Non salvato (${e?.code || 'errore'}): riprova`;
      }
      return;
    }
    if (EMBEDDED) {
      state.config.targets = { ...state.config.targets, monthly };
      let note = 'Salvato in questo browser';
      try { localStorage.setItem(TARGETS_KEY, JSON.stringify(monthly)); } catch (e) { note = 'Applicato fino alla chiusura della pagina'; }
      render();
      document.getElementById('tMsg').textContent = note;
      return;
    }
    try {
      const r = await fetch('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly }) });
      if (!r.ok) throw new Error(r.status);
      state.config.targets = { ...state.config.targets, monthly: (await r.json()).monthly };
      render();
      document.getElementById('tMsg').textContent = 'Salvato in data/config.json';
    } catch (e) {
      msg.textContent = 'Impossibile salvare: avvia la dashboard con python3 serve.py';
    }
  });
}

/* ---------- controlli ---------- */
function syncInputs() {
  document.getElementById('aFrom').value = state.a.from; document.getElementById('aTo').value = state.a.to;
  document.getElementById('bFrom').value = state.b.from; document.getElementById('bTo').value = state.b.to;
  document.querySelectorAll('#ptype button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.ptype));
  document.querySelectorAll('#ctype button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.ctype));
}
function recomputeB() {
  if (state.ctype === 'prev') {
    state.b = state.ptype === 'custom' ? shift(state.a, 'custom', -1) : shift(state.a, state.ptype, -1);
    // Periodo in corso: confronta a pari giorni trascorsi (1-13 ott vs 1-13 set), non con il periodo intero
    if (inRange(state.asOf, state.a) && state.asOf < state.a.to) {
      const to = D.add(state.b.from, D.diff(state.asOf, state.a.from));
      if (to < state.b.to) state.b = { from: state.b.from, to };
    }
  }
}
function bindControls() {
  document.querySelectorAll('#ptype button').forEach((b) => b.addEventListener('click', () => {
    state.ptype = b.dataset.v;
    if (state.ptype !== 'custom') state.a = periodFor(state.ptype, state.a.to < state.asOf ? state.a.to : state.asOf);
    recomputeB(); render();
  }));
  document.querySelectorAll('#ctype button').forEach((b) => b.addEventListener('click', () => { state.ctype = b.dataset.v; recomputeB(); render(); }));
  document.getElementById('prev').addEventListener('click', () => { state.a = shift(state.a, state.ptype, -1); recomputeB(); render(); });
  document.getElementById('next').addEventListener('click', () => { state.a = shift(state.a, state.ptype, 1); recomputeB(); render(); });
  const onA = () => {
    const f = document.getElementById('aFrom').value, t = document.getElementById('aTo').value;
    if (f && t && f <= t) { state.a = { from: f, to: t }; state.ptype = 'custom'; recomputeB(); render(); }
  };
  const onB = () => {
    const f = document.getElementById('bFrom').value, t = document.getElementById('bTo').value;
    if (f && t && f <= t) { state.b = { from: f, to: t }; state.ctype = 'custom'; render(); }
  };
  ['aFrom', 'aTo'].forEach((id) => document.getElementById(id).addEventListener('change', onA));
  ['bFrom', 'bTo'].forEach((id) => document.getElementById(id).addEventListener('change', onB));
  const sel = document.getElementById('snapshot');
  fillSnapshotSelect();
  document.getElementById('refresh').addEventListener('click', () => startLive(true));
  sel.addEventListener('change', () => { state.asOf = sel.value; state.a = periodFor(state.ptype === 'custom' ? 'month' : state.ptype, state.asOf); if (state.ptype === 'custom') state.ptype = 'month'; recomputeB(); render(); });
}

function fillSnapshotSelect() {
  const sel = document.getElementById('snapshot');
  sel.innerHTML = Object.keys(state.snaps).sort().reverse()
    .map((d) => `<option value="${d}">${dLabel(d)} ${d.slice(0, 4)}${state.snaps[d].live && d === Live.todayRome() ? ' · live' : ''}</option>`).join('');
  sel.value = state.asOf;
}

/* ---------- dati live (connettori) e storico (database dell'artifact) ---------- */
function renderLiveStatus() {
  const { state: st, errors, at } = state.live;
  const time = at ? new Date(at).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }) : '';
  const text = {
    saved: `Dati salvati al ${dLabel(Object.keys(state.snaps).sort().pop())}`,
    loading: 'Aggiornamento da HubSpot e Calendar…',
    live: `Live · aggiornato alle ${time}`,
    partial: `Live parziale · ${time}`,
    error: 'Connettori non raggiungibili · dati salvati',
  }[st];
  const el = document.getElementById('liveStatus');
  el.dataset.state = st;
  document.getElementById('liveText').textContent = text;
  // Freschezza: dice sempre a che ora sono stati letti da HubSpot i dati mostrati, e avvisa se non sono di oggi
  const shown = state.snaps[state.asOf];
  const fetched = shown?.source?.hubspot_fetched_at || shown?.generated_at;
  const fetchedTxt = fetched ? new Date(fetched).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const latestDate = Object.keys(state.snaps).sort().pop();
  const today = typeof Live !== 'undefined' ? Live.todayRome() : latestDate;
  const notes = [...errors];
  if (st !== 'loading' && state.asOf !== latestDate) notes.push(`Stai guardando i dati del ${dLabel(state.asOf)} (menu "Dati al"): scegli la data più recente per lo stato attuale dei deal.`);
  else if (st !== 'loading' && st !== 'live' && st !== 'partial' && latestDate < today) {
    notes.push(`Attenzione: i dati sono fermi al ${fetchedTxt || dLabel(latestDate)}. Le modifiche fatte dopo in HubSpot (es. un deal passato a Lost) qui non compaiono finché la pagina non si aggiorna da HubSpot: aprila da claude.ai con il connettore HubSpot attivo e premi "Aggiorna ora".`);
  }
  const msg = document.getElementById('liveMsg');
  msg.hidden = !notes.length;
  msg.textContent = notes.join(' ');
  document.getElementById('generated').textContent = fetchedTxt ? `HubSpot letto il ${fetchedTxt}` : '';
  document.getElementById('refresh').hidden = !state.mcp || st === 'loading';
}

let liveRunning = false;
async function startLive(refresh = false) {
  if (liveRunning || !window.claude?.use) return;
  liveRunning = true;
  try {
    if (!refresh) {
      const [db, user] = await Promise.all([
        window.claude.use('db').catch(() => null),
        window.claude.use('user').catch(() => null),
      ]);
      // Solo il proprietario interroga i connettori: chi apre un link condiviso userebbe il proprio calendario
      state.owner = user ? await user.isOwner().catch(() => false) : false;
      state.db = db;
      state.mcp = state.owner ? await window.claude.use('mcp').catch(() => null) : null;
      if (db) {
        try {
          const hist = await Live.loadHistory(db);
          Object.entries(hist).forEach(([d, s]) => {
            if (!state.snaps[d] || (s.generated_at || '') > (state.snaps[d].generated_at || '')) state.snaps[d] = s;
          });
          const pays = await db.collection('payments').get();
          // Il database ha la precedenza, deal per deal, sulla base incorporata
          state.payments = { ...(state.payments || {}), ...Object.fromEntries(pays.docs.map((d) => [String(d.data()?.deal_id ?? d.id), d.data()])) };
          const t = await db.doc('settings/targets').get();
          if (t.exists) state.config.targets = { ...state.config.targets, monthly: { ...(state.config.targets?.monthly || {}), ...(t.data().monthly || {}) } };
        } catch (e) { /* storico non leggibile: restano gli snapshot incorporati */ }
      }
    }
    if (!state.mcp) {
      const note = state.owner === false && state.db
        ? `Vista condivisa: dati dell'ultimo aggiornamento del ${dLabel(Object.keys(state.snaps).sort().pop())}.`
        : 'I connettori non sono disponibili in questa vista: mostro gli ultimi dati salvati.';
      state.asOf = Object.keys(state.snaps).sort().pop();
      if (state.ptype !== 'custom') { state.a = periodFor(state.ptype, state.asOf); recomputeB(); }
      state.live = { state: 'saved', errors: [note], at: null };
      fillSnapshotSelect(); renderLiveStatus(); render();
      return;
    }
    state.live = { ...state.live, state: 'loading', errors: [] };
    renderLiveStatus();
    const dates = Object.keys(state.snaps).sort();
    const previousLatest = dates[dates.length - 1];
    const { snapshot, errors } = await Live.load(state.mcp, state.config, state.snaps[previousLatest], refresh);
    if (!snapshot) {
      state.live = { state: 'error', errors, at: null };
      renderLiveStatus();
      return;
    }
    const stored = state.snaps[snapshot.snapshot_date];
    const following = state.asOf === previousLatest || state.asOf === snapshot.snapshot_date;
    state.snaps[snapshot.snapshot_date] = snapshot;
    if (following) {
      state.asOf = snapshot.snapshot_date;
      if (state.ptype !== 'custom') { state.a = periodFor(state.ptype, state.asOf); recomputeB(); }
    }
    state.live = { state: errors.length ? 'partial' : 'live', errors, at: snapshot.generated_at };
    fillSnapshotSelect(); renderLiveStatus(); render();
    // Storico: salva la fotografia del giorno (solo se cambiata). Solo il proprietario può scrivere.
    if (state.db && !snapshot.source.calendar_stale) {
      try { await Live.saveSnapshot(state.db, snapshot, stored); } catch (e) { /* lettore senza permessi di scrittura */ }
    }
  } finally {
    liveRunning = false;
  }
}

function render() {
  syncInputs();
  const snap = state.snaps[state.asOf];
  const latest = { deals: enrich(snap, state.asOf), events: snap.events };
  document.getElementById('who').textContent = `${state.config.owner.name} · ${state.config.owner.role}, ${state.config.owner.company} — HelloSmile / HelloVet`;
  renderLiveStatus(); // aggiorna l'indicazione di freschezza dei dati mostrati
  renderResult(latest);
  renderBridge(latest);
  renderCommissions(latest);
  renderFunnel(latest);
  renderForecast(latest);
  renderCohorts(latest);
  renderPipeline(latest);
  renderTrend();
  renderRisks(latest);
  renderDeals(latest);
  renderQuality(latest);
  renderTargetEditor();
}

load().then(() => {
  state.a = periodFor('month', state.asOf);
  recomputeB();
  bindControls();
  renderLiveStatus();
  render();
  // Dati live: all'apertura e ogni 15 minuti mentre la pagina è visibile
  startLive();
  setInterval(() => { if (document.visibilityState === 'visible') startLive(true); }, 15 * 60 * 1000);
}).catch((e) => {
  document.querySelector('main').innerHTML = `<section class="block"><h2>Impossibile caricare i dati</h2><p>${esc(e.message)}</p><p>Avvia la dashboard con <code>python3 serve.py</code> e apri <code>http://localhost:8000</code>.</p></section>`;
});
