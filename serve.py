#!/usr/bin/env python3
"""Server locale della dashboard KPI.

Uso:  python3 serve.py [porta]    ->  http://localhost:8000

Serve i file statici del repository e un unico endpoint di scrittura,
POST /api/targets, che salva i target mensili in data/config.json.
"""
import json
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "data" / "config.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/dashboard/")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/targets":
            self.send_error(404)
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            monthly = {
                k: float(v) for k, v in body.get("monthly", {}).items()
                if re.fullmatch(r"\d{4}-\d{2}", k) and v not in (None, "")
            }
        except (ValueError, TypeError) as exc:
            self.send_error(400, str(exc))
            return
        cfg = json.loads(CONFIG.read_text())
        cfg.setdefault("targets", {})["monthly"] = dict(sorted(monthly.items()))
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "monthly": cfg["targets"]["monthly"]}).encode())


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Dashboard KPI su http://localhost:{port}  (Ctrl+C per uscire)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
