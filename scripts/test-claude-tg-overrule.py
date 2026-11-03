#!/usr/bin/env python3
"""Self-check for claude-tg-overrule: python3 scripts/test-claude-tg-overrule.py (no network).
The relay's part (tap → ticket) is simulated by writing the ticket by hand."""
import importlib.machinery, importlib.util, io, json, os, tempfile, time
from contextlib import redirect_stdout
from pathlib import Path

state = Path(tempfile.mkdtemp())
os.environ["TELEGRAM_STATE_DIR"] = str(state)
path = str(Path(__file__).with_name("claude-tg-overrule"))
spec = importlib.util.spec_from_loader("ovr", importlib.machinery.SourceFileLoader("ovr", path))
ovr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ovr)
sent = []
ovr.send = lambda text, ident: sent.append((text, ident))


def run(fn, ev):
    out = io.StringIO()
    with redirect_stdout(out):
        fn(ev)
    return out.getvalue().strip()


call = {"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "ssh x 'ls; df'", "description": "a"}}
retry = {**call, "tool_input": {"command": "ssh x 'ls; df'", "description": "different text"}}

# Unknown session: nothing sent.
run(ovr.on_denied, {**call, "reason": "r"})
assert not sent
# Known session: message sent, request file for the relay, nothing allowed yet.
(state / "relay-state.json").write_text(json.dumps({"sessions": [{"sessionId": "s1", "label": "1·opus"}]}))
run(ovr.on_denied, {**call, "reason": "r"})
assert len(sent) == 1 and "ssh x 'ls; df'" in sent[0][0]
req = json.loads((ovr.DIR / f"{sent[0][1]}.json").read_text())
assert req["key"] == ovr.key(retry) and req["session_id"] == "s1"
assert run(ovr.on_pre_tool, retry) == ""
# The relay's "yes": a ticket. Exactly one allow, only for the same call in the same session.
(ovr.TICKETS / req["key"]).write_text(str(time.time() + 600))
assert run(ovr.on_pre_tool, {**call, "tool_input": {"command": "ssh x 'rm -rf /'"}}) == ""
assert run(ovr.on_pre_tool, {**retry, "session_id": "s2"}) == ""
assert json.loads(run(ovr.on_pre_tool, retry))["hookSpecificOutput"]["permissionDecision"] == "allow"
assert run(ovr.on_pre_tool, retry) == ""  # used up
# Expired ticket: no.
(ovr.TICKETS / req["key"]).write_text(str(time.time() - 1))
assert run(ovr.on_pre_tool, retry) == ""
print("ok")
