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
  a: null, b: null, dealFilter: 'all',
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

async function load() {
  [state.config, state.index] = await Promise.all([getJSON('../data/config.json'), getJSON('../data/index.json')]);
  const list = await Promise.all(state.index.snapshots.map((d) => getJSON(`../data/snapshots/${d}.json`).catch(() => null)));
  list.filter(Boolean).forEach((s) => { state.snaps[s.snapshot_date] = s; });
  state.asOf = state.index.latest;
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
  switch (d.stage) {
    case STAGE.NEGOTIATION:
      if (d.closedate && d.closedate >= today) return { date: d.closedate, basis: 'closedate HubSpot' };
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
  const cohort = deals.filter((d) => d.demo_date && inRange(d.demo_date, r) && d.demo_date <= today);
  const noshow = cohort.filter((d) => d.stage === STAGE.NO_SHOW).length;
  // Demo svolte: escludo i no-show e le demo passate con il deal ancora in Demo Scheduled (esito non registrato)
  const unrecorded = cohort.filter((d) => d.stage === STAGE.DEMO_SCHEDULED).length;
  const held = cohort.filter((d) => d.stage !== STAGE.NO_SHOW && d.stage !== STAGE.DEMO_SCHEDULED);
  const trial = held.filter((d) => TRIAL_OR_LATER.has(d.stage) || d.activation_date).length;
  const recorded = cohort.length - unrecorded;
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
    cohortSize: cohort.length, unrecorded, heldCount: held.length, trialCount: trial,
    showUp: recorded ? 1 - noshow / recorded : null,
    demoToTrial: held.length ? trial / held.length : null,
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
function targetFor(r) {
  // Somma dei target dei mesi interamente contenuti nel periodo
  const t = state.config.targets?.monthly || {};
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
  h += tile('Ticket medio', fa.avgTicket != null ? eur.format(fa.avgTicket) : '—', delta(fa.avgTicket, fb.avgTicket, { money: true }));
  h += tile('Deal persi', num.format(fa.lostCount), delta(fa.lostCount, fb.lostCount, { invert: true }),
    Object.entries(fa.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)}: ${v}`).join(' · '));
  document.getElementById('tilesResult').innerHTML = h;

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

function renderForecast(latest) {
  const months = [0, 1, 2].map((i) => D.month(D.addMonths(state.asOf, i)));
  const targets = state.config.targets?.monthly || {};
  let h = `<thead><tr><th>Mese di incasso</th><th class="n">Chiuso</th><th class="n">Pipeline pesata</th><th class="n">Previsto</th><th class="n">Target</th><th class="n">Gap previsto</th><th class="n">Best case</th><th class="n">Deal</th><th class="n">Rischio slittamento</th></tr></thead><tbody>`;
  months.forEach((m, i) => {
    const won = latest.deals.filter((d) => isWon(d) && d.closedate && D.month(d.closedate) === m);
    const open = latest.deals.filter((d) => isOpen(d) && d.incasso && D.month(d.incasso) === m);
    const closed = won.reduce((s, d) => s + d.amount, 0);
    const w = open.reduce((s, d) => s + d.weighted, 0);
    const best = closed + open.reduce((s, d) => s + d.amount, 0);
    const t = targets[m];
    const lateIn = latest.deals.filter((d) => isOpen(d) && d.exp?.late && d.exp.evaluation && D.month(d.exp.evaluation) === m);
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
  const first = D.month(D.addMonths(today, -5));
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
      trial: c.filter((d) => TRIAL_OR_LATER.has(d.stage) || d.activation_date).length,
      open: c.filter(isOpen).length, won: won.length, lost: c.filter((d) => d.info.group === 'lost').length,
      m0: by(0), m1: by(1), later, pipeW: c.filter(isOpen).reduce((s, d) => s + d.weighted, 0) };
  });
  let h = `<thead><tr><th>Coorte (mese demo)</th><th class="n">Deal</th><th class="n">No-show</th><th class="n">→ Prova</th><th class="n">Vinti</th><th class="n">Persi</th><th class="n">Aperti</th><th class="n">Win rate</th><th class="n">Incassato stesso mese</th><th class="n">Incassato mese +1</th><th class="n">Incassato dopo</th><th class="n">Pipeline pesata residua</th></tr></thead><tbody>`;
  rows.forEach((r) => {
    h += `<tr><td>${monthLabel(r.m)} <span class="muted">(${r.fromCal} da calendario)</span></td><td class="n">${r.n}</td><td class="n">${r.noshow}</td><td class="n">${r.trial}</td><td class="n">${r.won}</td><td class="n">${r.lost}</td><td class="n">${r.open}</td>
      <td class="n">${r.won + r.lost ? pct(r.won / (r.won + r.lost)) : '—'}</td><td class="n">${eur.format(r.m0)}</td><td class="n">${eur.format(r.m1)}</td><td class="n">${eur.format(r.later)}</td><td class="n">${eur.format(r.pipeW)}</td></tr>`;
  });
  document.getElementById('cohorts').innerHTML = h + `</tbody><caption class="muted" style="caption-side:bottom;text-align:left;padding-top:6px">Mese demo = prima demo trovata in calendario; se assente, data di creazione del deal. Win rate sui deal già decisi (vinti / vinti + persi).</caption>`;
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
    if (d.stage === STAGE.NEGOTIATION && d.closedate && d.closedate < today) add('serious', 'Negotiation con closedate scaduta', d, `closedate ${dLabel(d.closedate)}: aggiornare o chiudere`);
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
  let h = `<p class="muted">Fonte: HubSpot ${snap.source.hubspot_total} deal · Calendar ${snap.source.calendar_events} eventi (${dLabel(snap.source.calendar_range[0])} – ${dLabel(snap.source.calendar_range[1])}) · snapshot generato ${esc(snap.generated_at)}</p>`;
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
  el.innerHTML = `<div class="target-grid">${months.map((m) => `<label>${monthLabel(m)}<input type="number" min="0" step="100" data-m="${m}" value="${t[m] ?? ''}" placeholder="€"></label>`).join('')}</div>
    <div class="actions"><button id="saveTargets">Salva target</button><span class="muted" id="tMsg"></span></div>`;
  el.querySelector('#saveTargets').addEventListener('click', async () => {
    const monthly = { ...t };
    el.querySelectorAll('input[data-m]').forEach((i) => { if (i.value === '') delete monthly[i.dataset.m]; else monthly[i.dataset.m] = Number(i.value); });
    const msg = el.querySelector('#tMsg');
    try {
      const r = await fetch('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly }) });
      if (!r.ok) throw new Error(r.status);
      state.config.targets = { ...state.config.targets, monthly: (await r.json()).monthly };
      msg.textContent = 'Salvato in data/config.json';
      render();
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
  sel.innerHTML = Object.keys(state.snaps).sort().reverse().map((d) => `<option value="${d}">${dLabel(d)} ${d.slice(0, 4)}</option>`).join('');
  sel.addEventListener('change', () => { state.asOf = sel.value; state.a = periodFor(state.ptype === 'custom' ? 'month' : state.ptype, state.asOf); if (state.ptype === 'custom') state.ptype = 'month'; recomputeB(); render(); });
}

function render() {
  syncInputs();
  const snap = state.snaps[state.asOf];
  const latest = { deals: enrich(snap, state.asOf), events: snap.events };
  document.getElementById('who').textContent = `${state.config.owner.name} · ${state.config.owner.role}, ${state.config.owner.company} — HelloSmile / HelloVet`;
  document.getElementById('generated').textContent = `${Object.keys(state.snaps).length} snapshot salvati`;
  renderResult(latest);
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
  render();
}).catch((e) => {
  document.querySelector('main').innerHTML = `<section class="block"><h2>Impossibile caricare i dati</h2><p>${esc(e.message)}</p><p>Avvia la dashboard con <code>python3 serve.py</code> e apri <code>http://localhost:8000</code>.</p></section>`;
});
