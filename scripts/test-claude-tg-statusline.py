#!/usr/bin/env python3
"""Self-check of claude-tg-statusline: python3 test-claude-tg-statusline.py"""
import json, os, subprocess, tempfile
from pathlib import Path

script = Path(__file__).resolve().parent / "claude-tg-statusline"
with tempfile.TemporaryDirectory() as home:
    cache = Path(home) / ".local/state/claude-tg/usage.json"

    def run(payload):
        r = subprocess.run(["python3", str(script)], input=payload, capture_output=True, text=True,
                           env={**os.environ, "HOME": home}, check=True)
        return r.stdout.strip()

    assert run("not json") == "" and not cache.exists()
    assert run(json.dumps({"model": {}})) == "" and not cache.exists()

    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps({"retry_at": 123, "data": {"old": 1}}))
    out = run(json.dumps({"rate_limits": {"seven_day": {"used_percentage": 42.4, "resets_at": 1794322800},
                                          "five_hour": {"used_percentage": 7}}}))
    assert out == "5h 7% · week 42%", out
    st = json.loads(cache.read_text())
    assert st["retry_at"] == 123 and st["source"] == "statusline"
    assert st["data"]["seven_day"] == {"utilization": 42.4, "resets_at": "2026-11-10T15:00:00+00:00"}, st
    assert st["data"]["five_hour"]["resets_at"] is None and "old" not in st["data"]
    # A passed reset is dropped; garbage doesn't crash.
    out = run(json.dumps({"rate_limits": {"seven_day": {"used_percentage": 95, "resets_at": 1000},
                                          "five_hour": "x"}}))
    assert out == "" and json.loads(cache.read_text())["data"]["seven_day"]["utilization"] == 42.4
    assert run(json.dumps({"rate_limits": {"seven_day": {"used_percentage": 1, "resets_at": 1e300}}})) == ""
    assert run(json.dumps([1])) == ""
print("ok")
