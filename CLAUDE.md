# Dashboard KPI commerciali — istruzioni per Claude

Utente: Michele Tomassini, Account Executive in Agendoo AI (HelloSmile / HelloVet). Lingua: italiano.

## Procedura "aggiorna la dashboard KPI"

1. **HubSpot** (`search_crm_objects`, objectType `DEAL`):
   filtri `pipeline = 3234496704` AND `hubspot_owner_id = 35273657`, limit 200, paginando con `offset`
   finché non hai tutti i `total` record. Proprietà: dealname, dealstage, amount_in_home_currency,
   closedate, createdate, hs_lastmodifieddate, closed_lost_reason, hubspot_owner_id.
   Salva in `data/raw/hubspot_deals.json` nel formato
   `{"fetched_at": ISO, "results": [{"id": ..., "properties": {...}}]}` (oppure il formato compatto
   `columns`/`rows` già usato nel primo snapshot).
2. **Google Calendar** (`list_events`, calendario primario, `orderBy: startTime`, pageSize 250):
   intervallo da 3 mesi fa a 6 settimane avanti, paginando con `pageToken`. Gli output grandi vengono
   salvati su file: uniscili con jq in `data/raw/calendar_events.json`:
   `jq -s '{events: ([.[].events[]] | map({id, status, summary, start: (.start.dateTime // .start.date), allDay: (.start.date != null)}) | unique_by(.id))}' file1 file2 > data/raw/calendar_events.json`
3. `python3 scripts/ingest.py` → crea `data/snapshots/<oggi>.json` e aggiorna `data/index.json`.
   Se segnala stage non mappati, chiedi a Michele come mapparli in `data/config.json`.
4. Controlla gli eventi non abbinati (sezione Qualità dati); se una regola di classificazione è sbagliata,
   correggi le regex in `config.json` e rilancia l'ingest.
5. `python3 scripts/build_static.py` e ripubblica `dist/kpi-dashboard.html` con lo strumento Artifact
   sull'URL esistente `https://claude.ai/artifact/BDDnxYwrhwSEPfBnHfQuLe` (leggilo prima con `action: "read"`
   se la conversazione non l'ha già pubblicato), così il link di Michele resta lo stesso.
6. Commit di `data/snapshots/` e `data/index.json` (mai `data/raw/` né `dist/`) e push.

## Regole di dominio da rispettare in ogni modifica

- Ciclo demo → firma 24-30 gg: le demo di un mese generano fatturato nel mese **successivo**.
  Mai sommare demo del mese e fatturato del mese: sono coorti diverse.
- Ogni previsione di fatturato è per **mese di incasso**, non di attività.
- Valutazione fine prova dopo il 27 → incassa il mese dopo → va segnalata come rischio.
- Chiuso = somma `amount_in_home_currency` dei deal in Closed Won (4431899835) + Closed Won Paid
  (4961139914) con closedate nel periodo.
