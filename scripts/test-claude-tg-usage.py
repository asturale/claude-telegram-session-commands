#!/usr/bin/env python3
"""Self-check of the plan limits in claude-tg-usage: python3 test-claude-tg-usage.py
Runs offline: a retry_at in the future keeps it from calling the endpoint."""
import json, os, subprocess, tempfile, time
from pathlib import Path

script = Path(__file__).resolve().parent / "claude-tg-usage"
with tempfile.TemporaryDirectory() as home:
    cache = Path(home) / ".local/state/claude-tg/usage.json"
    cache.parent.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_OAUTH_TOKEN"}

    def run(st):
        cache.write_text(json.dumps(st))
        r = subprocess.run(["python3", str(script)], capture_output=True, text=True,
                           env={**env, "HOME": home}, check=True)
        return r.stdout

    now = time.time()
    # Status line data older than the cache window, no token: shown with its time.
    out = run({"source": "statusline", "fetched": now - 3600, "retry_at": now + 600, "data": {
        "seven_day": {"utilization": 42.4, "resets_at": "2999-01-05T15:00:00+00:00"},
        "five_hour": {"utilization": 88, "resets_at": "2000-01-01T00:00:00+00:00"}}})
    assert "week (all models): 42%" in out and "Claude Code's last reply" in out, out
    assert "5-hour" not in out, out  # its reset has passed
    # Nothing cached and no token: a hint instead of a crash.
    out = run({})
    assert "claude-tg-statusline" in out and "Plan limits" not in out, out
print("ok")
