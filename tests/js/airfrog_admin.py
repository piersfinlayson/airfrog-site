#!/usr/bin/env python3
# Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
#
# MIT License

"""Sets up an Airfrog for the browser tests, with airfrog-v2's test client.

Usage: airfrog_admin.py ADDRESS:PORT HOST [PASSWORD] COMMAND [ARG]
  ADDRESS:PORT  where Airfrog listens, for example 127.0.0.1:18180
  HOST          a Host Airfrog accepts, for example airfrog
  PASSWORD      Airfrog's password, '-' for none
  COMMAND       get-aliases | set-aliases A,B | set-password PW | clear-password

SET_PASSWORD's key is encrypted on a logged-in connection.

The AIRFROG_V2 environment variable is the airfrog-v2 checkout.
"""

import hashlib
import os
import socket
import struct
import sys

if "AIRFROG_V2" not in os.environ:
    sys.exit("AIRFROG_V2 not set")

address, port = sys.argv[1].rsplit(":", 1)
host, password, command = sys.argv[2], sys.argv[3], sys.argv[4]
arg = sys.argv[5] if len(sys.argv) > 5 else None

sys.argv = [sys.argv[0], port]
sys.path.insert(0, os.path.join(os.environ["AIRFROG_V2"], "test"))
import qemu_ws as q  # noqa: E402


def http(request, timeout=10):
    s = socket.create_connection((address, int(port)), timeout=timeout)
    s.sendall(request.encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    return s, data


q.http = http

c = q.Client(host=host)
h = q.hello(c)
if h["flags"] & 1:
    if password == "-":
        sys.exit("Airfrog has a password")
    k = hashlib.pbkdf2_hmac("sha256", password.encode(), h["salt"], h["iterations"])
    if not q.login(c, h, k):
        sys.exit("login failed")
t, _ = c.recv()
assert t == q.TARGET

if command == "get-aliases":
    t, p = c.command(q.GET_HOST_ALIASES)
    count = struct.unpack("<H", p[:2])[0]
    at, names = 2, []
    for _ in range(count):
        n = struct.unpack("<H", p[at:at + 2])[0]
        names.append(p[at + 2:at + 2 + n].decode())
        at += 2 + n
    print(",".join(names))
elif command == "set-aliases":
    names = [a for a in (arg or "").split(",") if a]
    t, p = c.command(q.SET_HOST_ALIASES, struct.pack("<H", len(names)) + b"".join(q.text(a.encode()) for a in names))
    assert t == q.AIRFROG_CMD, f"SET_HOST_ALIASES failed: {p.hex()}"
elif command == "set-password":
    salt = os.urandom(16)
    k = hashlib.pbkdf2_hmac("sha256", arg.encode(), salt, h["iterations"])
    t, p = c.command(q.SET_PASSWORD, q.password_fields(k, salt, c.session))
    assert t == q.AIRFROG_CMD, f"SET_PASSWORD failed: {p.hex()}"
elif command == "clear-password":
    t, p = c.command(q.SET_PASSWORD, q.password_fields(bytes(32), bytes(16), c.session))
    assert t == q.AIRFROG_CMD, f"SET_PASSWORD failed: {p.hex()}"
else:
    sys.exit(f"unknown command {command}")
