#!/usr/bin/env python3
"""App Store Connect helper for Iris Workplace release plumbing.

Stdlib only: the ES256 JWT is signed with the system `openssl` so nothing needs installing.
Reads the team API key from the env file (default ~/iris-ops/mobile/asc.env; override with
ASC_ENV). Nothing here uploads a build. Secrets are never printed.

    release/asc.py status                 # bundle id, app record, TestFlight groups, testers
    release/asc.py ensure-bundle-id       # register com.irisforu.workplace if it is missing
    release/asc.py ensure-internal-group  # internal TestFlight group "Owner" with the owner only
    release/asc.py builds                 # builds ASC has for the app (processing state)
    release/asc.py get <path>             # raw GET, e.g. /v1/apps?filter[bundleId]=…
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

BUNDLE_ID = os.environ.get("ASC_BUNDLE_ID", "com.irisforu.workplace")
APP_NAME = os.environ.get("ASC_APP_NAME", "Iris Workplace")
OWNER_EMAIL = os.environ.get("ASC_OWNER_EMAIL", "")  # optional; used by ensure-internal-group
GROUP_NAME = os.environ.get("ASC_INTERNAL_GROUP", "Owner")
BASE = "https://api.appstoreconnect.apple.com"
ENV_FILE = os.path.expanduser(os.environ.get("ASC_ENV", "~/iris-ops/mobile/asc.env"))


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def load_env(path: str = ENV_FILE) -> dict:
    """KEY=VALUE lines; '#' comments; values may be quoted. Keeps existing os.environ overrides."""
    out: dict = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_FILE"):
        if os.environ.get(k):
            out[k] = os.environ[k]
    missing = [k for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_FILE") if not out.get(k)]
    if missing:
        sys.exit(f"asc: {path} is missing {', '.join(missing)}")
    out["ASC_KEY_FILE"] = os.path.expanduser(out["ASC_KEY_FILE"])
    if not os.path.isabs(out["ASC_KEY_FILE"]):
        out["ASC_KEY_FILE"] = os.path.join(os.path.dirname(path), out["ASC_KEY_FILE"])
    if not os.path.exists(out["ASC_KEY_FILE"]):
        sys.exit("asc: ASC_KEY_FILE does not exist at the declared path")
    return out


def _der_to_raw(der: bytes) -> bytes:
    """DER-encoded ECDSA signature -> 64-byte r||s (P-256)."""
    assert der[0] == 0x30
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    assert der[i] == 0x02
    rl = der[i + 1]
    r = der[i + 2:i + 2 + rl]
    j = i + 2 + rl
    assert der[j] == 0x02
    sl = der[j + 1]
    s = der[j + 2:j + 2 + sl]
    return r.lstrip(b"\x00").rjust(32, b"\x00") + s.lstrip(b"\x00").rjust(32, b"\x00")


class ASC:
    def __init__(self, env: dict):
        self.key_id, self.issuer, self.key_file = env["ASC_KEY_ID"], env["ASC_ISSUER_ID"], env["ASC_KEY_FILE"]
        self._jwt: tuple | None = None

    def token(self) -> str:
        now = int(time.time())
        if self._jwt and now - self._jwt[1] < 15 * 60:
            return self._jwt[0]
        head = _b64(json.dumps({"alg": "ES256", "kid": self.key_id, "typ": "JWT"}).encode())
        body = _b64(json.dumps({"iss": self.issuer, "iat": now, "exp": now + 19 * 60,
                                "aud": "appstoreconnect-v1"}).encode())
        signing_input = f"{head}.{body}".encode()
        with tempfile.NamedTemporaryFile() as f:
            f.write(signing_input)
            f.flush()
            der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.key_file, f.name],
                                 check=True, capture_output=True).stdout
        tok = f"{head}.{body}.{_b64(_der_to_raw(der))}"
        self._jwt = (tok, now)
        return tok

    def call(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        url = path if path.startswith("http") else BASE + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:  # noqa: BLE001
                return e.code, {"raw": raw.decode(errors="replace")[:400]}

    def get_all(self, path: str) -> list:
        items: list = []
        status, body = self.call("GET", path)
        _ok(status, body, path)
        items += body.get("data", [])
        while body.get("links", {}).get("next"):
            status, body = self.call("GET", body["links"]["next"])
            _ok(status, body, path)
            items += body.get("data", [])
        return items


def _ok(status: int, body: dict, what: str) -> None:
    if status >= 300:
        errs = body.get("errors") or [body]
        msg = "; ".join(f"{e.get('status', status)} {e.get('title', '')}: {e.get('detail', e)}" for e in errs)
        sys.exit(f"asc: {what} failed: {msg}")


def bundle_id(asc: ASC) -> dict | None:
    q = urllib.parse.quote(BUNDLE_ID)
    for b in asc.get_all(f"/v1/bundleIds?filter[identifier]={q}&limit=200"):
        if b["attributes"]["identifier"] == BUNDLE_ID:
            return b
    return None


def app(asc: ASC) -> dict | None:
    q = urllib.parse.quote(BUNDLE_ID)
    for a in asc.get_all(f"/v1/apps?filter[bundleId]={q}&limit=200"):
        if a["attributes"]["bundleId"] == BUNDLE_ID:
            return a
    return None


def cmd_status(asc: ASC) -> int:
    b = bundle_id(asc)
    print(f"bundle id {BUNDLE_ID}: " + (f"registered (name '{b['attributes']['name']}', platform {b['attributes']['platform']})" if b else "NOT registered"))
    a = app(asc)
    if not a:
        print("app record: MISSING — create it in App Store Connect (see release/README.md)")
        return 2
    print(f"app record: present — '{a['attributes']['name']}' (id {a['id']}, sku {a['attributes'].get('sku')}, primary locale {a['attributes'].get('primaryLocale')})")
    groups = asc.get_all(f"/v1/apps/{a['id']}/betaGroups?limit=200")
    if not groups:
        print("testflight groups: none")
    for g in groups:
        at = g["attributes"]
        testers = asc.get_all(f"/v1/betaGroups/{g['id']}/betaTesters?limit=200")
        who = ", ".join(t["attributes"].get("email") or "?" for t in testers) or "(no testers)"
        print(f"testflight group '{at['name']}': {'internal' if at.get('isInternalGroup') else 'external'}, all builds={at.get('hasAccessToAllBuilds')}, testers: {who}")
    return 0


def cmd_ensure_bundle_id(asc: ASC) -> int:
    if bundle_id(asc):
        print(f"bundle id {BUNDLE_ID}: already registered")
        return 0
    status, body = asc.call("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {
        "identifier": BUNDLE_ID, "name": APP_NAME.replace(" ", ""), "platform": "IOS"}}})
    _ok(status, body, "register bundle id")
    print(f"bundle id {BUNDLE_ID}: registered (id {body['data']['id']})")
    return 0


def cmd_ensure_internal_group(asc: ASC) -> int:
    a = app(asc)
    if not a:
        print("app record missing; create it first (release/README.md)")
        return 2
    groups = asc.get_all(f"/v1/apps/{a['id']}/betaGroups?limit=200")
    g = next((g for g in groups if g["attributes"]["name"] == GROUP_NAME and g["attributes"].get("isInternalGroup")), None)
    if g:
        print(f"internal group '{GROUP_NAME}': present (id {g['id']})")
    else:
        status, body = asc.call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {
            "name": GROUP_NAME, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": {"data": {"type": "apps", "id": a["id"]}}}}})
        _ok(status, body, "create internal group")
        g = body["data"]
        print(f"internal group '{GROUP_NAME}': created (id {g['id']})")
    testers = asc.get_all(f"/v1/betaGroups/{g['id']}/betaTesters?limit=200")
    emails = [t["attributes"].get("email") for t in testers]
    print(f"  testers now: {', '.join(e or '?' for e in emails) or '(none)'}")
    if OWNER_EMAIL and OWNER_EMAIL not in emails:
        # Internal testers are team members; the API adds them by their betaTester record.
        found = asc.get_all(f"/v1/betaTesters?filter[email]={urllib.parse.quote(OWNER_EMAIL)}&limit=50")
        if found:
            status, body = asc.call("POST", f"/v1/betaGroups/{g['id']}/relationships/betaTesters",
                                    {"data": [{"type": "betaTesters", "id": found[0]["id"]}]})
            _ok(status, body, "add owner to internal group")
            print(f"  added {OWNER_EMAIL}")
        else:
            status, body = asc.call("POST", "/v1/betaTesters", {"data": {"type": "betaTesters",
                "attributes": {"email": OWNER_EMAIL},
                "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": g["id"]}]}}}})
            if status >= 300:
                errs = body.get("errors") or [body]
                print("  could not add the owner by API: " + "; ".join(str(e.get("detail", e)) for e in errs))
                print("  -> add him in App Store Connect: app > TestFlight > Internal Testing > "
                      f"'{GROUP_NAME}' > Testers (+) > pick the owner's team user")
                return 3
            print(f"  added {OWNER_EMAIL}")
    return 0


def cmd_builds(asc: ASC) -> int:
    a = app(asc)
    if not a:
        print("app record missing")
        return 2
    builds = asc.get_all(f"/v1/builds?filter[app]={a['id']}&sort=-uploadedDate&limit=20&fields[builds]=version,uploadedDate,processingState,expired")
    if not builds:
        print("no builds uploaded yet")
    for b in builds:
        at = b["attributes"]
        print(f"build {at['version']}  {at.get('processingState')}  uploaded {at.get('uploadedDate')}  expired={at.get('expired')}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    asc = ASC(load_env())
    cmd = argv[1]
    if cmd == "status":
        return cmd_status(asc)
    if cmd == "ensure-bundle-id":
        return cmd_ensure_bundle_id(asc)
    if cmd == "ensure-internal-group":
        return cmd_ensure_internal_group(asc)
    if cmd == "builds":
        return cmd_builds(asc)
    if cmd == "get" and len(argv) > 2:
        status, body = asc.call("GET", argv[2])
        print(status)
        print(json.dumps(body, indent=2)[:20000])
        return 0 if status < 300 else 1
    print(__doc__.strip())
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
