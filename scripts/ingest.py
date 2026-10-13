#!/usr/bin/env python3
"""Crea uno snapshot storico a partire dai dati grezzi di HubSpot e Google Calendar.

Uso:
    python3 scripts/ingest.py [--date YYYY-MM-DD]
        [--deals data/raw/hubspot_deals.json]
        [--calendar data/raw/calendar_events.json]

Scrive data/snapshots/<data>.json e aggiorna data/index.json.
Uno snapshot per giorno: rieseguire nello stesso giorno sovrascrive quello del giorno.
"""
import argparse
import json
import math
import re
import unicodedata
from collections import Counter
from datetime import datetime, date
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Parole che non identificano un cliente (titoli, tipologie di studio, parole dei titoli evento).
STOPWORDS = set("""
studio studi dentistico dentistici dentista dentist dott dottor dottore dottoressa dssa dr drssa doc
clinica cliniche veterinaria veterinario veterinari veterinaro vet ambulatorio ambulatori centro odontoiatrico
odontoiatria medico medica medicina poliambulatorio hellosmile hellovet hello smile demo assistente virtuale
per con del della delle dei degli di da la le il lo gli un una e x and the prova gratuita gratis attivazione
valutazione risultati prossimi passi trial setting follow up info telefono michele tomassini srl s r l
group gruppo partnership referral cliente sede onboarding call feedback sig ra sigra assistente citta
palermo roma milano catania bologna lecco viterbo rimini montesilvano alcamo napoli torino
""".split())

# Nomi di battesimo comuni: da soli non bastano per abbinare un evento a un deal (troppi omonimi).
FIRST_NAMES = set("""
alberto alessandra alessandro alessia alessio andrea angelo anna annalisa antonio barbara bernardo carlo
carlotta carmen caterina cecilia celeste chiara cinzia claudia consuelo cristina damiana daniela daniele
davide debora domenico elena eliana elisabetta emanuela enrico erika fabio fausto federica federico filippo
francesca francesco gabriele gianluca giacomo gioacchino giovanna giulia giulio giuseppe ilaria laura
leonardo lorenzo loredana luca lucia luigi mara marco margherita maria marisa mario marzia massimo matteo
mattia maurizio mauro michele mirena monica nadia nicola nicolo olga paola paolo pietro raffaele riccardo
roberto rosa sara silvia silvio simona stefano thomas tommaso valentina valeria valerio veronica vincenzo
vittoria vittorio
""".split())


def norm(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def tokens(text):
    return {t for t in norm(text).split() if len(t) >= 4 and t not in STOPWORDS and not t.isdigit()}


def to_local(ts, tz):
    if not ts:
        return None
    if len(ts) == 10:  # data senza orario
        return datetime.fromisoformat(ts).replace(tzinfo=tz)
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(tz)


def load_deals(path):
    raw = json.loads(Path(path).read_text())
    if "rows" in raw:  # formato compatto
        cols = raw["columns"]
        return [dict(zip(cols, r)) for r in raw["rows"]], raw
    results = raw if isinstance(raw, list) else raw.get("results", [])
    deals = []
    for r in results:
        p = dict(r.get("properties", {}))
        p["id"] = r.get("id", p.get("hs_object_id"))
        deals.append(p)
    return deals, raw


def classify(summary, cfg):
    s = summary or ""
    rx = lambda key: re.search(cfg[key], s, re.I)
    if rx("cancelled"):
        return "cancellato"
    if rx("exclude"):
        return "altro"
    if rx("valutazione"):
        return "valutazione"
    if rx("attivazione"):
        return "attivazione"
    if rx("demo"):
        return "demo"
    if rx("demo_inferred") and not rx("demo_inferred_exclude"):
        return "demo"
    return "altro"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--deals", default=str(DATA / "raw" / "hubspot_deals.json"))
    ap.add_argument("--calendar", default=str(DATA / "raw" / "calendar_events.json"))
    args = ap.parse_args()

    cfg = json.loads((DATA / "config.json").read_text())
    tz = ZoneInfo(cfg["timezone"])
    snap_date = args.date or datetime.now(tz).date().isoformat()

    deals_raw, deals_meta = load_deals(args.deals)
    cal_raw = json.loads(Path(args.calendar).read_text())
    events_raw = cal_raw.get("events", cal_raw)

    # --- Deal normalizzati
    deals = []
    for d in deals_raw:
        if str(d.get("hubspot_owner_id", cfg["hubspot"]["owner_id"])) != cfg["hubspot"]["owner_id"]:
            continue
        amt = d.get("amount_in_home_currency")
        deals.append({
            "id": str(d["id"]),
            "name": (d.get("dealname") or "").strip(),
            "stage": str(d.get("dealstage")),
            "amount": float(amt) if amt not in (None, "") else 0.0,
            "closedate": to_local(d.get("closedate"), tz).date().isoformat() if d.get("closedate") else None,
            "createdate": to_local(d.get("createdate"), tz).date().isoformat(),
            "lastmod": to_local(d.get("hs_lastmodifieddate"), tz).date().isoformat(),
            "lost_reason": d.get("closed_lost_reason"),
        })

    # --- Eventi calendario classificati (solo eventi con orario: gli all-day sono promemoria)
    events = []
    for e in events_raw:
        if e.get("allDay") or e.get("status") == "cancelled":
            continue
        start = to_local(e["start"], tz)
        events.append({
            "id": e["id"],
            "date": start.date().isoformat(),
            "time": start.strftime("%H:%M"),
            "summary": (e.get("summary") or "").strip(),
            "kind": classify(e.get("summary"), cfg["calendar"]),
            "deal_id": None,
            "match_score": 0,
        })

    # --- Abbinamento evento -> deal per token del nome (pesati per rarità)
    deal_tokens = {d["id"]: tokens(d["name"]) for d in deals}
    df = Counter(t for ts in deal_tokens.values() for t in ts)
    n = max(len(deals), 1)
    idf = {t: math.log(1 + n / c) for t, c in df.items()}
    # A parità di punteggio preferisci il deal più "vivo" (non perso, più recente)
    group = {k: v["group"] for k, v in cfg["stages"].items()}
    rank_live = {"open": 4, "won": 3, "noshow": 2, "reactivation": 1, "lost": 0}
    by_id = {d["id"]: d for d in deals}

    for ev in events:
        if ev["kind"] in ("altro",):
            continue
        et = tokens(ev["summary"])
        best, best_score = None, 0.0
        for did, dt in deal_tokens.items():
            shared = et & dt
            if not shared or shared <= FIRST_NAMES:
                continue
            score = sum(idf[t] for t in shared)
            d = by_id[did]
            # Il deal deve esistere prima dell'evento, con tolleranza (deal creati dopo la demo)
            key = (score, rank_live.get(group.get(d["stage"]), 0), d["createdate"])
            if best is None or key > best[0]:
                best = (key, did)
                best_score = score
        if best and best_score >= 2.0:
            ev["deal_id"] = best[1]
            ev["match_score"] = round(best_score, 2)

    # --- Date di ciclo per deal dal calendario
    for d in deals:
        evs = sorted((e for e in events if e["deal_id"] == d["id"]), key=lambda e: (e["date"], e["time"]))
        demos = [e["date"] for e in evs if e["kind"] == "demo"]
        acts = [e["date"] for e in evs if e["kind"] == "attivazione"]
        vals = [e["date"] for e in evs if e["kind"] == "valutazione"]
        d["demo_date"] = demos[0] if demos else None
        d["demo_date_source"] = "calendar" if demos else "createdate"
        d["activation_date"] = acts[0] if acts else None
        d["evaluation_date"] = vals[-1] if vals else None
        d["events"] = [e["id"] for e in evs]

    snapshot = {
        "snapshot_date": snap_date,
        "generated_at": datetime.now(tz).isoformat(timespec="seconds"),
        "source": {
            "hubspot_fetched_at": deals_meta.get("fetched_at") if isinstance(deals_meta, dict) else None,
            "hubspot_total": len(deals),
            "calendar_events": len(events),
            "calendar_range": [min((e["date"] for e in events), default=None), max((e["date"] for e in events), default=None)],
        },
        "deals": deals,
        "events": [e for e in events if e["kind"] != "altro"],
    }

    out_dir = DATA / "snapshots"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{snap_date}.json").write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))

    snaps = sorted(p.stem for p in out_dir.glob("*.json"))
    (DATA / "index.json").write_text(json.dumps({"snapshots": snaps, "latest": snaps[-1]}, indent=1))

    matched = sum(1 for e in events if e["deal_id"])
    classified = sum(1 for e in events if e["kind"] in ("demo", "attivazione", "valutazione"))
    unknown = sorted({d["stage"] for d in deals if d["stage"] not in cfg["stages"]})
    print(f"Snapshot {snap_date}: {len(deals)} deal, {len(events)} eventi ({classified} demo/attivazioni/valutazioni, {matched} abbinati a un deal)")
    if unknown:
        print(f"ATTENZIONE: stage non mappati in config.json: {', '.join(unknown)}")


if __name__ == "__main__":
    main()
