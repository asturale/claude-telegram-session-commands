#!/usr/bin/env python3
"""Self-test of the /mcp buttons in claude-tg-mcp: python3 test-claude-tg-mcp.py"""
import importlib.machinery, importlib.util, re
from pathlib import Path

path = str(Path(__file__).resolve().parent / "claude-tg-mcp")
spec = importlib.util.spec_from_loader("mcp", importlib.machinery.SourceFileLoader("mcp", path))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TG_CWD = "/p"
d = {"projects": {"/p": {"mcpServers": {"alpha": {}, "beta": {}},
                         "disabledMcpServers": ["beta", "claude.ai Some Thing", "plugin:telegram:telegram"]}}}
assert m.servers(d, "/p") == {"alpha": True, "beta": False, "claude.ai Some Thing": False}
assert m.rows(d, "/p") == ["off:alpha\talpha ✕", "on:beta\t+ beta", "on:claude.ai_Some_Thing\t+ claude.ai Some Thing"]
# Every value must pass the plugin's button check.
for line in m.rows(d, "/p"):
    assert re.fullmatch(r"[A-Za-z0-9_.:-]{1,40}", line.split("\t")[0]), line
assert len("off:" + m.slug("x" * 99)) <= 40
assert m.rows(d, "/p", ["beta"])[1:] == ["on:claude.ai_Some_Thing\t+ claude.ai Some Thing"]  # a worktree's missing server shows once
print("ok")
