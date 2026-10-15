#!/usr/bin/env python3
"""VPS Manager web version (Termux / any Python 3.8+). Standard library only.

All app logic lives in www/core.js + www/index.html (shared with the Android app).
This server only serves those files and provides two helpers the browser cannot do:
  POST /native/http   -> forwards an HTTPS call to the MehranHost API (no CORS problems)
  POST /native/copyid -> creates an SSH key (ssh-keygen) and installs it on the server
                         with ssh-copy-id (needs `pkg install openssh sshpass`)
  POST /native/ssh    -> runs a script as root over SSH using that key
                         (empty password = key auth; paramiko is used if installed)

Run:  python app.py     then open http://127.0.0.1:8080
"""
import json, os, shutil, subprocess, sys
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(BASE, "www")
API_PREFIX = "https://www.mehranhost.cloud/api/v1/"
PORT = int(os.environ.get("PORT", "8080"))
FILES = {"/": ("index.html", "text/html; charset=utf-8"),
         "/core.js": ("core.js", "application/javascript; charset=utf-8")}


def forward(d):
    url = d.get("url", "")
    if not url.startswith(API_PREFIX) and not os.environ.get("VPSM_ALLOW_ANY_URL"):
        raise ValueError("URL not allowed")
    body = d.get("body")
    req = urllib.request.Request(url, data=body.encode() if body else None, method=d.get("method", "GET"))
    for k, v in (d.get("headers") or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return {"status": r.status, "headers": {k.lower(): v for k, v in r.headers.items()}, "body": r.read().decode()}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": {k.lower(): v for k, v in e.headers.items()}, "body": e.read().decode()}


KEY = os.environ.get("VPSM_KEY") or os.path.join(os.path.expanduser("~"), ".ssh", "vpsm_ed25519")
SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=20"]


def ensure_key():
    """Create the key pair once (ssh-keygen); reused for every server."""
    if os.path.exists(KEY) and os.path.exists(KEY + ".pub"):
        return
    if not shutil.which("ssh-keygen"):
        raise RuntimeError("Install openssh: pkg install openssh")
    os.makedirs(os.path.dirname(KEY), mode=0o700, exist_ok=True)
    for f in (KEY, KEY + ".pub"):
        if os.path.exists(f):
            os.remove(f)
    p = subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "vps-manager", "-f", KEY],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ssh-keygen failed: " + (p.stderr or p.stdout))


def copy_id(d):
    host, user, pw = d["host"], d.get("user", "root"), d["password"]
    ensure_key()
    if not (shutil.which("sshpass") and shutil.which("ssh-copy-id")):
        raise RuntimeError("Install: pkg install openssh sshpass")
    # ssh-copy-id: appends the public key to ~/.ssh/authorized_keys on the server
    p = subprocess.run(
        ["sshpass", "-p", pw, "ssh-copy-id", "-i", KEY + ".pub"] + SSH_OPTS + [f"{user}@{host}"],
        capture_output=True, text=True, timeout=120)
    return {"code": p.returncode, "out": p.stdout, "err": p.stderr}


def ssh(d):
    host, user, script = d["host"], d.get("user", "root"), d["script"]
    ensure_key()
    try:
        import paramiko  # type: ignore
    except ImportError:
        paramiko = None
    if paramiko:
        cl = paramiko.SSHClient()
        cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        cl.connect(host, username=user, key_filename=KEY, timeout=30, allow_agent=False, look_for_keys=False)
        stdin, stdout, stderr = cl.exec_command("bash -s", timeout=900)
        stdin.write(script)
        stdin.channel.shutdown_write()
        out, err = stdout.read().decode(), stderr.read().decode()
        code = stdout.channel.recv_exit_status()
        cl.close()
        return {"code": code, "out": out, "err": err}
    p = subprocess.run(
        ["ssh", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"] + SSH_OPTS + [f"{user}@{host}", "bash -s"],
        input=script, capture_output=True, text=True, timeout=900)
    return {"code": p.returncode, "out": p.stdout, "err": p.stderr}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, data, ctype="application/json; charset=utf-8"):
        b = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        f = FILES.get(self.path.split("?")[0])
        if not f:
            return self.send(404, {"error": "not found"})
        with open(os.path.join(WWW, f[0]), "rb") as fh:
            self.send(200, fh.read(), f[1])

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            d = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/native/http":
                return self.send(200, forward(d))
            if self.path == "/native/copyid":
                return self.send(200, copy_id(d))
            if self.path == "/native/ssh":
                return self.send(200, ssh(d))
            self.send(404, {"error": "not found"})
        except Exception as e:
            self.send(200, {"error": str(e)})


if __name__ == "__main__":
    print(f"Open http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
