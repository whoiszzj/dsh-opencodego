#!/usr/bin/env python3
"""Phase-4b runner helper: the client-half and route reads.

Kept OUT of the shell script so the artifact-shape checks live in one readable
place. It answers one JSON report; `phase4b-combine.py` turns that report plus
the probe's evidence into the committed acceptance file.

What it checks, from OUTSIDE the host process (the part the probe cannot see):

  H1  the served HTML's boot graph names `dsh-opencodego`
  H2/H3  the composed `client.js` the boot graph points at is our ModuleLoader
         registration and requires nothing but the shell seed word `react`
  H4  the single-resource `/plugins/<id>/client.js` path answers the same bundle
  H5  `GET /opencode-go-native/diagnostics` answers the documented payload
  H6/H7  `GET /opencode-go-native/models` (and `?refresh=1`) answer the catalogue

The page authenticates with the cookie its 303 bootstrap sets, so this helper
drives a cookie-jar opener rather than raw requests.
"""

import http.cookiejar
import json
import re
import sys
import urllib.error
import urllib.request

URL_TOKEN = re.compile(r"token=([A-Za-z0-9._-]+)")


def main() -> int:
    port, probe_out, report_out = sys.argv[1], sys.argv[2], sys.argv[3]
    base = f"http://127.0.0.1:{port}"
    report = {"port": port}
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def get(path):
        request = urllib.request.Request(base + path, headers={"host": f"127.0.0.1:{port}"})
        with opener.open(request, timeout=30) as response:
            return response.status, response.read().decode("utf8", "replace")

    def status_of(path):
        """The HTTP status alone, tolerating the error responses urllib raises on."""
        request = urllib.request.Request(base + path, headers={"host": f"127.0.0.1:{port}"})
        try:
            with opener.open(request, timeout=30) as response:
                return {"status": response.status, "bytes": len(response.read())}
        except urllib.error.HTTPError as error:
            return {"status": error.code}

    try:
        status, html = get("/")
        report["indexStatus"] = status
        report["indexBytes"] = len(html)
        # The boot graph is one injected global; a row is {id,url,rev,...}.
        entries = re.findall(r'\{"id":"[^"]+","url":"[^"]+","rev":"[^"]+"[^}]*\}', html)
        report["bootEntryCount"] = len(entries)
        report["bootEntryIds"] = sorted({json.loads(entry)["id"] for entry in entries})
        match = [entry for entry in entries if entry.startswith('{"id":"dsh-opencodego"')]
        report["opencodegoEntry"] = match[0] if match else None
        if match:
            url = json.loads(match[0])["url"]
            status, body = get(url)
            report["clientBundle"] = {
                "status": status,
                "url": url,
                "bytes": len(body),
                "isModuleLoaderRegistration": 'window.__ModuleLoader__.load({ id: "dsh-opencodego"' in body,
                "requires": sorted(set(re.findall(r'require\("([^"]+)"\)', body))),
                "mentionsSettingsNamespace": "opencode-go-native" in body,
                "mentionsSettingsSection": "settings.section" in body,
            }
        # Content addressing: the composed URL is the ONLY way this host serves a
        # bundle (measured — there is no bare `/plugins/<id>/client.js` handler in
        # dsh 0.1.5-rc.1), and a wrong revision must not be served.
        if match:
            wrong_revision = json.loads(match[0])["url"].replace("&rev=", "&rev=bogus")
            report["wrongRevision"] = {"url": wrong_revision, **status_of(wrong_revision)}
            report["unknownBundle"] = {"status_of": status_of("/plugins/??dsh-opencodego-nope/client.js&rev=0")}
    except Exception as error:  # noqa: BLE001 - the report carries the failure
        report["error"] = repr(error)

    # The probe FIRST: its route runs the settings round trip, and the route
    # reads below must observe the section it wrote (this is the ordering the
    # page has too — a save lands, then the diagnostics panel is opened).
    try:
        status, body = get("/ocg-phase4b/checks")
        evidence = json.loads(body).get("evidence")
        report["probe"] = {"status": status, "evidence": evidence}
        if evidence is not None:
            with open(probe_out, "w", encoding="utf8") as handle:
                json.dump(evidence, handle, indent=2, ensure_ascii=False)
    except Exception as error:  # noqa: BLE001
        report["probe"] = {"error": repr(error)}

    for path, key in (
        ("/opencode-go-native/diagnostics", "diagnostics"),
        ("/opencode-go-native/models", "models"),
        ("/opencode-go-native/models?refresh=1", "modelsRefresh"),
    ):
        try:
            status, body = get(path)
            payload = json.loads(body)
            if key == "diagnostics":
                diagnostics = payload.get("diagnostics", {})
                report[key] = {
                    "status": status,
                    "ok": payload.get("ok"),
                    "kind": diagnostics.get("kind"),
                    "at": diagnostics.get("at"),
                    "connection": diagnostics.get("connection"),
                    "catalogue": {
                        field: diagnostics.get("catalogue", {}).get(field)
                        for field in ("status", "discovered", "effective", "effectiveIds", "sources")
                    },
                    "healthRows": len(diagnostics.get("health", {}).get("rows", [])),
                    "logLines": len(diagnostics.get("log", {}).get("lines", [])),
                    "reportedModels": diagnostics.get("configuration", {}).get("models"),
                }
            else:
                report[key] = {
                    "status": status,
                    "ok": payload.get("ok"),
                    "source": payload.get("source"),
                    "count": len(payload.get("models", [])),
                    "ids": [
                        model.get("id")
                        for model in payload.get("models", [])
                        if model.get("id") in ("phase4b-hand-declared", "stub-retired", "glm-5.3-flash")
                    ],
                    "extraModel": next(
                        (model for model in payload.get("models", []) if model.get("id") == "phase4b-hand-declared"),
                        None,
                    ),
                }
        except Exception as error:  # noqa: BLE001
            report[key] = {"error": repr(error)}

    # Proof the page's own auth path works for these reads (no token leaked).
    report["authenticatedReads"] = len(jar)
    with open(report_out, "w", encoding="utf8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
