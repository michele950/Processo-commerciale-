# Dashboard KPI commerciali — istruzioni per Claude

Utente: Michele Tomassini, Account Executive in Agendoo AI (HelloSmile / HelloVet). Lingua: italiano.

## Dashboard live

https://claude.ai/artifact/BDDnxYwrhwSEPfBnHfQuLe legge HubSpot e Google Calendar in diretta quando la apre
Michele (capability `mcp` + `db` per lo storico giornaliero, collection `snapshots`, e `settings/targets`).
`dashboard/live.js` replica `scripts/ingest.py`: ogni modifica alle regole di classificazione/abbinamento va
fatta in entrambi (le liste di parole stanno in `config.json` → `matching`) e verificata con un confronto
di parità sugli stessi dati grezzi. Dopo modifiche al codice: `python3 scripts/build_static.py` e
ripubblicare `dist/kpi-dashboard.html` sullo stesso URL mantenendo le capability.

Regole di abbinamento (`config.json` → `matching`): parole generiche ignorate, nomi di battesimo da soli
validi solo se il deal si chiama così, `aliases` per le grafie diverse (es. Sgroi = Sgrò), ed eventi più
vecchi di `max_days_before_create` giorni rispetto alla creazione del deal ignorati (trattativa precedente).

## Procedura "aggiorna la dashboard KPI" (snapshot nel repository)

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

## Creazione di deal su HubSpot (su richiesta di Michele)

- Nome: `<nome struttura> - <nome referente>` (struttura dalle risposte Calendly "Nome della struttura").
- Pipeline 3234496704, fase Demo Scheduled, proprietario 35273657, importo 1788 se non indicato.
- **Closedate di default: data della demo (o della creazione del task) + 30 giorni.**
- Mostrare sempre la tabella delle modifiche e attendere l'ok prima di scrivere.

## Target e commissioni (`config.json` → `targets`, `compensation`)

- Fonte: "Accordo di trasformazione" del 1/10/2026, art. 6-7 (prima: lettera "Nuove disposizioni concordate").
- Base di calcolo: valore annuo dei nuovi contratti sottoscritti nel mese (closedate); i rinnovi contano al 50%
  (riconosciuti dalla parola "rinnovo" nel nome del deal: `renewal_pattern`, `renewal_weight`). Vale solo per le
  commissioni: chiuso, ticket e KPI di vendita restano sull'importo pieno.
- Quote: settembre 14.000, ottobre 20.000, da novembre 25.000 (`default_from`; anche in `settings/targets` del db).
  Quote, soglia e aliquote valide fino al 31/12/2026.
- Commissioni: 0 sotto il 70% della quota; sopra, 8% fino al 100% della quota, 10% dal 100% al 140%
  (`upper_pct`), 15% oltre il 140% (a regime 25.000 / 35.000; ottobre 20.000 / 28.000). Maturano alla firma,
  liquidate dopo l'incasso nel primo cedolino utile (al più tardi quello del mese dopo l'incasso); con Antonio:
  busta dello stesso mese, pagata la prima settimana del mese successivo (`payment_lag_months` = 0).
- Fisso: RAL 24.000 su 13 mensilità. Accordo con Antonio: in busta escono SEMPRE 1.600 € netti + 200 € di buoni
  pasto, a prescindere dall'IRPEF (`net_fixed`, `meal_vouchers`; l'art. 7 da 8 €/giorno non si usa). Le commissioni
  portano solo la loro tassazione marginale sul reddito annuo (RAL + commissioni).
- Firmato vs incassato: la commissione MATURA sul contrattato del mese di firma (scaglioni sul totale del mese),
  si ripartisce sui deal in proporzione all'importo ed è EROGATA in busta nel mese in cui il cliente paga ogni rata.
  Piani: single (predefinito, rata unica alla firma), quarterly (3 rate uguali ogni 3 mesi), semiannual (2 rate a 6 mesi),
  custom. Le rate sono persistite (non ricalcolate): db collection `payments` (doc = id deal:
  {plan, installments: [{amount, date AAAA-MM-GG | '' = da confermare, status paid | expected}], note}) con base in
  `data/payments.json` (il db ha la precedenza per deal). Erogato = rate incassate; previsto = anche quelle da incassare.
  Benefit e aliquota si applicano al totale erogato in ogni busta.
- Netto commissioni (`compensation.payroll`): stima con IRPEF sul reddito annuo cumulato (INPS 9,19%, scaglioni
  2026 23/33/43%, detrazioni art. 13, cuneo 2025, addizionali ~2,3%). Ipotesi A = RAL 24.000 (confermata dall'accordo),
  ipotesi B = 1.600 netti garantiti (lordo ≈ 29.500). I primi ~1.000 € della commissione di ogni busta sono
  benefit esenti (`commission_benefit_monthly`), già netti: si tassa solo l'eccedenza. Da confermare con la busta paga di ottobre.

## Regole di dominio da rispettare in ogni modifica

- Ciclo demo → firma 24-30 gg: le demo di un mese generano fatturato nel mese **successivo**.
  Mai sommare demo del mese e fatturato del mese: sono coorti diverse.
- Ogni previsione di fatturato è per **mese di incasso**, non di attività.
- Valutazione fine prova dopo il 27 → incassa il mese dopo → va segnalata come rischio.
- La closedate HubSpot di un deal aperto è la sua data di incasso prevista (precede ogni stima).
- Periodo di riferimento da settembre 2026 (`config.json` → `analysis_start`): luglio/agosto esclusi da totali, coorti e grafici.
- La pipeline Reactivation (4126512317) è esclusa: sono opportunità perse in riattivazione.
- Demo svolte = demo fissate meno no-show (demo passate senza esito in HubSpot contano come svolte).
- Tassi solo su coorti mature (`config.json` → `maturity`): demo → trial su demo di almeno 7 giorni;
  trial → chiusura su prove concluse (vinte/perse) o attivate da almeno 17 giorni; demo → chiusura = prodotto.
- Chiuso = somma `amount_in_home_currency` dei deal in Closed Won (4431899835) + Closed Won Paid
  (4961139914) con closedate nel periodo.
