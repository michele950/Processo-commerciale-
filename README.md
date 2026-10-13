# Dashboard KPI commerciali — Michele Tomassini (Agendoo AI)

Dashboard web locale per il monitoraggio delle KPI commerciali di HelloSmile / HelloVet.
Ogni aggiornamento salva uno **snapshot storico** in `data/snapshots/AAAA-MM-GG.json`, così si possono
confrontare periodi diversi e vedere i trend, non solo la fotografia del giorno.

## Avvio

```bash
python3 serve.py          # poi apri http://localhost:8000
```

Nessuna dipendenza: solo Python 3.9+ e un browser.

## Aggiornare i dati

I dati arrivano dai connettori MCP (HubSpot, Google Calendar), quindi l'aggiornamento si fa da
Claude Code: basta chiedere **"aggiorna la dashboard KPI"**. La procedura è descritta in `CLAUDE.md`:

1. scarica i deal della pipeline `3234496704` con owner `35273657` in `data/raw/hubspot_deals.json`;
2. scarica gli eventi del calendario primario in `data/raw/calendar_events.json`;
3. esegue `python3 scripts/ingest.py`, che scrive lo snapshot del giorno e aggiorna `data/index.json`;
4. fa commit dello snapshot (è la memoria storica della dashboard).

## La regola del ciclo di vendita

Il ciclo demo → firma dura 24-30 giorni (demo → attivazione ~7 gg → prova 14 gg → valutazione → firma 2-3 gg).
Per questo la dashboard **non somma mai demo e fatturato dello stesso mese**:

- il fatturato e il forecast sono espressi per **mese di incasso**;
- le attività (demo, attivazioni, valutazioni) per **mese di attività**;
- una valutazione fissata dopo il 27 incassa il mese successivo e viene segnalata come rischio.

## Sezioni

1. **Risultato**: chiuso nel periodo (Closed Won + Closed Won Paid per closedate), target, % target, gap, previsto incasso del mese, ticket medio, persi con motivi.
2. **Forecast per mese di incasso**: mese corrente e due successivi, con chiuso, pipeline pesata, best case e rischio di slittamento.
3. **Attività del periodo**: demo, show-up rate, demo → prova, attivazioni, valutazioni, nuovi deal, pipeline a fine periodo.
4. **Coorti demo → incasso**: per mese di demo, quanto è stato incassato nello stesso mese, nel mese dopo e oltre.
5. **Pipeline per stage**, con delta rispetto allo snapshot del periodo di confronto.
6. **Trend dagli snapshot**: pipeline aperta, previsto e chiuso del mese nel tempo.
7. **Rischi e azioni**: valutazioni dopo il 27, prove senza valutazione fissata, negotiation con closedate scaduta, deal fermi.
8. **Deal aperti**, filtrabili per mese di incasso, con link a HubSpot.
9. **Qualità dati**: eventi del calendario senza deal, stage non mappati, deal vinti senza closedate.

Il confronto "periodo precedente" di un periodo in corso è a pari giorni trascorsi (es. 1-13 ott vs 1-13 set).

## Configurazione (`data/config.json`)

- `stages`: mappa degli stage della pipeline.
- `cycle`: durate del ciclo e giorno limite (27) per l'incasso nel mese.
- `forecast_probability`: probabilità di firma per stage usate nel forecast pesato (da calibrare).
- `targets.monthly`: target per mese di incasso (`"2026-10": 25000`), modificabili anche dalla dashboard.
- `calendar`: regex che classificano gli eventi in demo / attivazione / valutazione.

## Come vengono calcolati i dati del calendario

`scripts/ingest.py` classifica gli eventi del calendario con le regex di `config.json` e li abbina ai deal
confrontando le parole distintive del titolo con il nome del deal (titoli, tipologie di studio, città e nomi
di battesimo da soli non bastano). Da qui ricava, per ogni deal, data demo, data attivazione e data valutazione.
Gli abbinamenti mancanti finiscono nella sezione *Qualità dati*.
