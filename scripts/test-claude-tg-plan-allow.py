#!/usr/bin/env python3
"""claude-tg-plan-allow approves only reply/react without files."""
import json
import subprocess
from pathlib import Path

HOOK = Path(__file__).with_name("claude-tg-plan-allow")


def decide(tool, inp):
    out = subprocess.run([str(HOOK)], input=json.dumps({"tool_name": tool, "tool_input": inp}),
                         capture_output=True, text=True, check=True).stdout.strip()
    return json.loads(out)["hookSpecificOutput"]["decision"]["behavior"] if out else None


R = "mcp__plugin_telegram_telegram__reply"
assert decide(R, {"chat_id": "1", "text": "hi"}) == "allow"
assert decide("mcp__plugin_telegram_telegram__react", {"chat_id": "1", "emoji": "👍"}) == "allow"
assert decide(R, {"chat_id": "1", "text": "hi", "files": ["/etc/passwd"]}) is None
assert decide(R, {"chat_id": "1", "text": "hi", "files": []}) == "allow"
assert decide("Bash", {"command": "rm -rf /"}) is None
assert decide("mcp__plugin_telegram_telegram__edit_message", {"text": "x"}) is None
assert subprocess.run([str(HOOK)], input="not json", capture_output=True, text=True).stdout == ""
print("ALL PASS")
