#!/usr/bin/env python3
"""Phase-4b runner helper: fold the probe's evidence and the client-half report.

The committed acceptance file is ONE document: the A–F assertions the probe ran
inside the host process, plus the H assertions this repo can only make from
outside it (the served boot graph, the served bundle, the route payloads).
"""

import datetime
import json
import os
import sys


def main() -> int:
    probe_path, client_path, repo = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(client_path, encoding="utf8") as handle:
        client = json.load(handle)

    probe = client.get("probe") or {}
    evidence = probe.get("evidence")
    if evidence is None:
        if os.path.exists(probe_path):
            with open(probe_path, encoding="utf8") as handle:
                evidence = json.load(handle)
        else:
            evidence = {
                "probe": "phase4b",
                "assertions": [],
                "failures": ["the probe route answered no evidence"],
            }

    assertions = list(evidence.get("assertions", []))
    failures = list(evidence.get("failures", []))

    def add(name, ok, detail=None):
        assertions.append({"name": name, "pass": bool(ok), "detail": detail})
        if not ok:
            failures.append(name)

    entry = client.get("opencodegoEntry")
    add("H1 the served boot graph names dsh-opencodego", entry is not None, entry)
    bundle = client.get("clientBundle") or {}
    add(
        "H2 the composed client bundle is served and is our ModuleLoader registration",
        bundle.get("status") == 200 and bundle.get("isModuleLoaderRegistration") is True,
        {key: bundle.get(key) for key in ("status", "bytes", "isModuleLoaderRegistration", "mentionsSettingsSection")},
    )
    add(
        "H3 the bundle requires nothing but the shell seed word 'react'",
        bundle.get("requires") == ["react"],
        bundle.get("requires"),
    )
    # This host serves plugin bundles ONLY through the content-addressed composed
    # URL; a bare `/plugins/<id>/client.js` is not a route (measured). So the
    # honest assertion is content addressing: the advertised revision answers,
    # a wrong one does not.
    wrong = client.get("wrongRevision") or {}
    unknown = (client.get("unknownBundle") or {}).get("status_of") or {}
    add(
        "H4 a wrong bundle revision is NOT served (the served bytes are content-addressed)",
        wrong.get("status") == 404 and unknown.get("status") == 404,
        {"wrongRevision": wrong, "unknownBundle": unknown},
    )
    diagnostics = client.get("diagnostics") or {}
    add(
        "H5 GET /diagnostics answers the documented kind",
        diagnostics.get("status") == 200 and diagnostics.get("kind") == "dsh-opencodego/diagnostics",
        diagnostics.get("kind"),
    )
    add(
        "H6 GET /diagnostics reports the overlay the round trip wrote",
        (diagnostics.get("reportedModels") or {}).get("extra") == ["phase4b-hand-declared"]
        and (diagnostics.get("reportedModels") or {}).get("disabled") == ["stub-retired"],
        diagnostics.get("reportedModels"),
    )
    models = client.get("models") or {}
    add(
        "H7 GET /models serves the effective catalogue after the round trip",
        models.get("status") == 200 and models.get("ok") is True and models.get("count", 0) >= 1,
        {key: models.get(key) for key in ("status", "count", "ids")},
    )
    refresh = client.get("modelsRefresh") or {}
    add(
        "H8 GET /models?refresh=1 forces a re-discovery",
        refresh.get("status") == 200 and refresh.get("source") == "endpoint" and refresh.get("count", 0) > 0,
        {key: refresh.get(key) for key in ("status", "source", "count")},
    )

    # `client["probe"]["evidence"]` IS this dict for the route path; embed the
    # client report without it, or json.dump sees a cycle.
    client_half = {key: value for key, value in client.items() if key != "probe"}
    client_half["probeAssertions"] = len(evidence.get("assertions", []))
    evidence["clientHalf"] = client_half
    evidence["assertions"] = assertions
    evidence["failures"] = failures
    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d")
    target = os.path.join(repo, "data", f"acceptance-phase4b-{stamp}.json")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf8") as handle:
        json.dump(evidence, handle, indent=2, ensure_ascii=False)

    print(f"\n== combined assertions: {len(assertions)}  failures: {len(failures)}")
    for item in assertions:
        print(("PASS " if item["pass"] else "FAIL "), item["name"])
    print(f"== copied to data/acceptance-phase4b-{stamp}.json")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
