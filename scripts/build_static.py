#!/usr/bin/env python3
"""Genera una versione a file unico della dashboard, con dati, stile e script incorporati.

Uso: python3 scripts/build_static.py [output]   (default: dist/kpi-dashboard.html)

Il file non richiede server né Python: si apre nel browser o si pubblica come pagina condivisibile.
I target modificati nella pagina statica restano solo nel browser di chi la usa.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DASH = ROOT / "dashboard"


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "kpi-dashboard.html"
    index = json.loads((DATA / "index.json").read_text())
    payload = {
        "config": json.loads((DATA / "config.json").read_text()),
        "index": index,
        "snapshots": [json.loads((DATA / "snapshots" / f"{d}.json").read_text()) for d in index["snapshots"]],
        # Piani di incasso dei deal chiusi (base; nella pagina live il database ha la precedenza)
        "payments": json.loads((DATA / "payments.json").read_text()) if (DATA / "payments.json").exists() else {},
    }
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    html = (DASH / "index.html").read_text()
    head = re.search(r"<title>.*?</title>", html, re.S).group(0)
    icon = re.search(r'<link rel="icon"[^>]*>', html)
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = body.replace('<script src="live.js"></script>', "").replace('<script src="app.js"></script>', "")
    # Immagini locali incorporate come data URI (la pagina pubblicata non può caricare file esterni)
    import base64
    for img in re.findall(r'src="([\w.-]+\.(?:jpg|png))"', body):
        b64 = base64.b64encode((DASH / img).read_bytes()).decode()
        mime = "image/png" if img.endswith(".png") else "image/jpeg"
        body = body.replace(f'src="{img}"', f'src="data:{mime};base64,{b64}"')
    css = (DASH / "styles.css").read_text()
    js = ((DASH / "live.js").read_text() + "\n" + (DASH / "app.js").read_text()).replace("</script", "<\\/script")

    page = "\n".join([
        head,
        icon.group(0) if icon else "",
        f"<style>\n{css}\n</style>",
        body.strip(),
        f'<script type="application/json" id="kpi-data">{data}</script>',
        f"<script>\n{js}\n</script>",
    ])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    print(f"Scritto {out} ({len(page) // 1024} KB, {len(payload['snapshots'])} snapshot)")


if __name__ == "__main__":
    main()
