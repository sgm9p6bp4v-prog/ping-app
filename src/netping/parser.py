"""
Ping output parser.

Behavioural copy of `parse_ping_output()` from Francesco's prototype
(`00_infos/ping-dashboard.zip` → `main.py`). Sprint 1 captures this
exact behaviour with golden tests; Sprint 2 may refactor.

Known limitations (documented in tests):
- macOS `-W <ms>` reply outside wait window → reports "No response".
- Italian locale on Linux/macOS (`tempo=`) → not recognised; only
  Windows-branch handles Italian today.
"""

from __future__ import annotations

import re


def parse_ping_output(output: str, os_name: str) -> dict:
    """Parse ping output for latency and packet loss.

    Args:
        output: Combined stdout+stderr of the `ping` invocation.
        os_name: Result of `platform.system()` — "Windows" branches into
            Italian/English regex; anything else uses the Unix branch.

    Returns:
        dict with keys: rtt_ms (float|None), success (bool), error (str|None).
    """
    result: dict = {"rtt_ms": None, "success": False, "error": None}

    if os_name == "Windows":
        # Match "Tempo=XXms" or "time=XXms"
        match = re.search(r"[Tt]empo[<=](\d+)ms|[Tt]ime[<=](\d+)ms", output)
        if match:
            rtt = match.group(1) or match.group(2)
            result["rtt_ms"] = float(rtt)
            result["success"] = True
        elif "host non raggiungibile" in output.lower() or "unreachable" in output.lower():
            result["error"] = "Host unreachable"
        elif "timeout" in output.lower() or "scaduto" in output.lower():
            result["error"] = "Request timed out"
        else:
            result["error"] = "No response"
    else:
        # macOS / Linux: "time=12.3 ms"
        match = re.search(r"time[<=]([\d.]+)\s*ms", output)
        if match:
            result["rtt_ms"] = float(match.group(1))
            result["success"] = True
        elif "unreachable" in output.lower():
            result["error"] = "Host unreachable"
        elif "timeout" in output.lower() or "no answer" in output.lower():
            result["error"] = "Request timed out"
        else:
            result["error"] = "No response"

    return result
