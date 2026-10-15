/* Dati live: la pagina legge HubSpot e Google Calendar con i connettori di chi la apre
 * (capability `mcp` dell'artifact) e costruisce lo snapshot del giorno con le stesse regole
 * di scripts/ingest.py. Lo storico giornaliero si salva nel database dell'artifact (`db`).
 */
'use strict';

const Live = (() => {
  const HUBSPOT = 'HubSpot';
  const CALENDAR = 'Google Calendar';
  const TZ = 'Europe/Rome';

  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const localDay = (ts) => (ts ? dayFmt.format(new Date(ts)) : null);
  const todayRome = () => dayFmt.format(new Date());

  /* ---------- regole condivise con scripts/ingest.py ---------- */
  const norm = (text) => (text || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = (text, stop) => new Set(norm(text).split(' ').filter((t) => t.length >= 4 && !stop.has(t) && !/^\d+$/.test(t)));

  function classify(summary, cfg) {
    const s = summary || '';
    const rx = (k) => new RegExp(cfg[k], 'i').test(s);
    if (rx('cancelled')) return 'cancellato';
    if (rx('exclude')) return 'altro';
    if (rx('valutazione')) return 'valutazione';
    if (rx('attivazione')) return 'attivazione';
    if (rx('demo')) return 'demo';
    if (rx('demo_inferred') && !rx('demo_inferred_exclude')) return 'demo';
    return 'altro';
  }

  /** Stessa struttura degli snapshot in data/snapshots/. */
  function buildSnapshot(dealsRaw, eventsRaw, config, meta) {
    const ownerId = config.hubspot.owner_id;
    const deals = dealsRaw
      .map((r) => ({ id: r.id ?? r.properties?.hs_object_id, ...r.properties }))
      .filter((p) => String(p.hubspot_owner_id ?? ownerId) === ownerId)
      .map((p) => ({
        id: String(p.id),
        name: (p.dealname || '').trim(),
        stage: String(p.dealstage),
        amount: p.amount_in_home_currency != null && p.amount_in_home_currency !== '' ? Number(p.amount_in_home_currency) : 0,
        closedate: localDay(p.closedate),
        createdate: localDay(p.createdate),
        lastmod: localDay(p.hs_lastmodifieddate),
        lost_reason: p.closed_lost_reason ?? null,
      }));

    const events = eventsRaw
      .filter((e) => e.start?.dateTime && e.status !== 'cancelled') // gli all-day sono promemoria
      .map((e) => {
        const dt = new Date(e.start.dateTime);
        return {
          id: e.id, date: localDay(dt), time: timeFmt.format(dt), summary: (e.summary || '').trim(),
          kind: classify(e.summary, config.calendar), deal_id: null, match_score: 0,
        };
      });

    // Abbinamento evento -> deal per parole distintive del nome, pesate per rarità
    const stop = new Set(config.matching.stopwords);
    const first = new Set(config.matching.first_names);
    const dealTokens = deals.map((d) => [d.id, tokens(d.name, stop)]);
    const df = new Map();
    dealTokens.forEach(([, ts]) => ts.forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const n = Math.max(deals.length, 1);
    const idf = new Map([...df].map(([t, c]) => [t, Math.log(1 + n / c)]));
    const rankLive = { open: 4, won: 3, noshow: 2, reactivation: 1, lost: 0 };
    const byId = new Map(deals.map((d) => [d.id, d]));
    const greater = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);

    events.forEach((ev) => {
      if (ev.kind === 'altro') return;
      const et = tokens(ev.summary, stop);
      let best = null, bestScore = 0;
      dealTokens.forEach(([id, dt]) => {
        const shared = [...et].filter((t) => dt.has(t));
        if (!shared.length || shared.every((t) => first.has(t))) return;
        const score = shared.reduce((s, t) => s + idf.get(t), 0);
        const d = byId.get(id);
        const key = [score, rankLive[config.stages[d.stage]?.group] ?? 0, d.createdate];
        if (!best || greater(key, best[0])) { best = [key, id]; bestScore = score; }
      });
      if (best && bestScore >= config.matching.min_score) {
        ev.deal_id = best[1];
        ev.match_score = Math.round(bestScore * 100) / 100;
      }
    });

    deals.forEach((d) => {
      const evs = events.filter((e) => e.deal_id === d.id).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      const pick = (k) => evs.filter((e) => e.kind === k).map((e) => e.date);
      const demos = pick('demo'), acts = pick('attivazione'), vals = pick('valutazione');
      d.demo_date = demos[0] || null;
      d.demo_date_source = demos.length ? 'calendar' : 'createdate';
      d.activation_date = acts[0] || null;
      d.evaluation_date = vals.length ? vals[vals.length - 1] : null;
      d.events = evs.map((e) => e.id);
    });

    const dates = events.map((e) => e.date).sort();
    return {
      snapshot_date: meta.date,
      generated_at: new Date().toISOString(),
      live: true,
      source: {
        hubspot_fetched_at: meta.hubspotAt, hubspot_total: deals.length, calendar_events: events.length,
        calendar_range: [dates[0] || null, dates[dates.length - 1] || null], calendar_stale: !!meta.calendarStale,
      },
      deals,
      events: events.filter((e) => e.kind !== 'altro'),
    };
  }

  /* ---------- connettori ---------- */
  const payloadOf = (res) => {
    const p = res?.payload ?? res;
    if (typeof p === 'string') { try { return JSON.parse(p); } catch (e) { return null; } }
    return p;
  };

  async function fetchDeals(mcp, config, refresh) {
    const h = config.hubspot;
    const all = [];
    let offset;
    for (let page = 0; page < 20; page++) {
      const input = {
        objectType: 'DEAL',
        filterGroups: [{ filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: h.pipeline },
          { propertyName: 'hubspot_owner_id', operator: 'EQ', value: h.owner_id },
        ] }],
        properties: h.properties,
        limit: 200,
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        chatInsights: { userIntent: 'Live KPI dashboard reading owned deals of the sales pipeline', satisfaction: 'NEUTRAL' },
      };
      if (offset != null) input.offset = offset;
      const res = await mcp.callTool(HUBSPOT, 'search_crm_objects', input, { cache: refresh ? { refresh: true, staleTime: 0 } : { staleTime: 120000 } });
      const p = payloadOf(res);
      if (!p || !Array.isArray(p.results)) throw { code: 'tool_error', server: HUBSPOT, message: 'Risposta HubSpot inattesa' };
      all.push(...p.results);
      if (!p.results.length || all.length >= (p.total ?? all.length) || p.offset == null) break;
      offset = p.offset;
    }
    return all;
  }

  async function fetchEvents(mcp, config, today, refresh) {
    // Da inizio del mese di 3 mesi fa a 6 settimane avanti (come la procedura in CLAUDE.md)
    const [y, m] = today.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 4, 1)).toISOString().slice(0, 10);
    const endD = new Date(Date.UTC(y, m - 1, Number(today.slice(8)) + 42)).toISOString().slice(0, 10);
    const all = [];
    let pageToken;
    for (let page = 0; page < 12; page++) {
      const input = { startTime: `${start}T00:00:00`, endTime: `${endD}T00:00:00`, pageSize: 250, orderBy: 'startTime' };
      if (pageToken) input.pageToken = pageToken;
      const res = await mcp.callTool(CALENDAR, 'list_events', input, { cache: refresh ? { refresh: true, staleTime: 0 } : { staleTime: 120000 } });
      const p = payloadOf(res);
      if (!p || !Array.isArray(p.events)) throw { code: 'tool_error', server: CALENDAR, message: 'Risposta Calendar inattesa' };
      all.push(...p.events);
      pageToken = p.nextPageToken;
      if (!pageToken) break;
    }
    return all;
  }

  /** Messaggio per l'utente in base al codice d'errore del connettore. */
  function explain(err, server) {
    const s = err?.server || server;
    switch (err?.code) {
      case 'needs_reauth': return `${s}: ricollega il connettore in claude.ai → Impostazioni → Connettori.`;
      case 'server_not_connected': return `${s}: aggiungi il connettore in claude.ai → Impostazioni → Connettori.`;
      case 'selection_required': return `${s}: hai più connettori con questo nome, scegli quale usare quando claude.ai lo chiede.`;
      case 'not_in_manifest': case 'approval_required': case 'consent_required':
        return `${s}: accesso non consentito a questa pagina. Riapri la pagina e consenti l'accesso quando richiesto.`;
      case 'blocked_by_policy': return `${s}: bloccato dalle policy della tua organizzazione.`;
      case 'server_unavailable': case 'rate_limited': return `${s}: momentaneamente non raggiungibile, riprova tra poco.`;
      case 'not_granted': case 'capability_disabled': case 'capability_removed':
        return 'Questa vista non può usare i connettori: mostro gli ultimi dati salvati.';
      default: return `${s}: ${err?.message || 'errore sconosciuto'}`;
    }
  }

  const retryOnce = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!e?.retryable) throw e;
      await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs ?? 0, 10000) + 500 + Math.random() * 1000));
      return fn();
    }
  };

  /**
   * Scarica i dati live. Restituisce {snapshot, errors}. Se Calendar non risponde ma HubSpot sì,
   * usa gli eventi dell'ultimo snapshot salvato (segnalato in source.calendar_stale).
   */
  async function load(mcp, config, fallbackSnap, refresh = false) {
    const today = todayRome();
    const errors = [];
    let dealsRaw = null, eventsRaw = null, hubspotAt = null;
    const [d, e] = await Promise.allSettled([
      retryOnce(() => fetchDeals(mcp, config, refresh)),
      retryOnce(() => fetchEvents(mcp, config, today, refresh)),
    ]);
    if (d.status === 'fulfilled') { dealsRaw = d.value; hubspotAt = new Date().toISOString(); } else errors.push(explain(d.reason, HUBSPOT));
    if (e.status === 'fulfilled') eventsRaw = e.value; else errors.push(explain(e.reason, CALENDAR));
    if (!dealsRaw) return { snapshot: null, errors };

    if (eventsRaw) return { snapshot: buildSnapshot(dealsRaw, eventsRaw, config, { date: today, hubspotAt }), errors };
    // Calendar non disponibile: deal live + eventi dall'ultimo snapshot salvato
    const snap = buildSnapshot(dealsRaw, [], config, { date: today, hubspotAt, calendarStale: true });
    if (fallbackSnap) {
      const old = new Map(fallbackSnap.deals.map((x) => [x.id, x]));
      snap.events = fallbackSnap.events;
      snap.source.calendar_range = fallbackSnap.source.calendar_range;
      snap.deals.forEach((x) => {
        const o = old.get(x.id);
        if (o) Object.assign(x, { demo_date: o.demo_date, demo_date_source: o.demo_date_source, activation_date: o.activation_date, evaluation_date: o.evaluation_date, events: o.events });
      });
    }
    return { snapshot: snap, errors };
  }

  /* ---------- storico nel database dell'artifact ---------- */
  const comparable = (s) => JSON.stringify([s.deals, s.events]);

  async function loadHistory(db) {
    const out = {};
    const snap = await db.collection('snapshots').get();
    snap.docs.forEach((doc) => { const v = doc.data(); if (v?.snapshot_date) out[v.snapshot_date] = v; });
    return out;
  }

  /** Salva lo snapshot del giorno solo se diverso da quello già salvato. */
  async function saveSnapshot(db, snapshot, existing) {
    if (existing && comparable(existing) === comparable(snapshot)) return false;
    await db.doc(`snapshots/${snapshot.snapshot_date}`).set(snapshot);
    return true;
  }

  return { load, buildSnapshot, loadHistory, saveSnapshot, todayRome, explain };
})();
