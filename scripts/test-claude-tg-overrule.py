#!/usr/bin/env python3
"""Self-check for claude-tg-overrule's side: python3 scripts/test-claude-tg-overrule.py
A fake relay socket checks what the hook sends and that only {"allow": true} allows.
The relay's ticket logic is tested live (see README)."""
import json, os, socket, subprocess, tempfile, threading
from pathlib import Path

state = Path(tempfile.mkdtemp())
hook = str(Path(__file__).with_name("claude-tg-overrule"))
seen, replies = [], []


def serve(srv):
    while True:
        conn, _ = srv.accept()
        with conn:
            msg = json.loads(conn.makefile().readline())
            seen.append(msg)
            if msg["t"] == "ovr-use":
                conn.sendall((json.dumps(replies.pop(0)) + "\n").encode())


def run(ev):
    env = {**os.environ, "TELEGRAM_STATE_DIR": str(state)}
    return subprocess.run([hook], input=json.dumps(ev), capture_output=True, text=True, env=env).stdout.strip()


call = {"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "ls; df", "description": "x"}}
# No relay: no decision, no crash.
assert run({**call, "hook_event_name": "PreToolUse"}) == ""

srv = socket.socket(socket.AF_UNIX)
srv.bind(str(state / "relay.sock"))
srv.listen()
threading.Thread(target=serve, args=(srv,), daemon=True).start()

assert run({**call, "hook_event_name": "PermissionDenied", "reason": "r"}) == ""
assert seen[-1] == {"t": "ovr-ask", **call, "reason": "r"}
for reply, allowed in (({"allow": True}, True), ({"allow": False}, False), ({}, False), ({"allow": "yes"}, False)):
    replies.append(reply)
    out = run({**call, "hook_event_name": "PreToolUse"})
    assert seen[-1] == {"t": "ovr-use", **call}
    assert (json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "allow") if allowed else out == "", (reply, out)
print("ok")
