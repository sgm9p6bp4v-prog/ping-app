"""
Golden / Characterisation Tests for `netping.parser.parse_ping_output`.

Sprint-1 baseline: locks in CURRENT behaviour of Francesco's parser
(including its bugs). Refactor work in Sprint 2+ must keep these tests
green OR update them deliberately with rationale.
"""

from __future__ import annotations

import pytest

from netping.parser import parse_ping_output

# --- macOS / Linux branch (Unix) ----------------------------------------------


class TestUnixSuccess:
    def test_macos_clean_success_parses_rtt(self, ping_fixture):
        out = ping_fixture("macos_success_en_clean.txt")
        r = parse_ping_output(out, "Darwin")
        assert r["success"] is True
        assert r["rtt_ms"] == pytest.approx(14.479)
        assert r["error"] is None

    def test_linux_success_parses_rtt(self, ping_fixture):
        out = ping_fixture("linux_success_en.txt")
        r = parse_ping_output(out, "Linux")
        assert r["success"] is True
        assert r["rtt_ms"] == pytest.approx(12.3)
        assert r["error"] is None


class TestUnixFailures:
    def test_macos_timeout_no_rtt(self, ping_fixture):
        out = ping_fixture("macos_timeout_en.txt")
        r = parse_ping_output(out, "Darwin")
        assert r["success"] is False
        assert r["rtt_ms"] is None
        # Note: 100% packet loss line does NOT contain "timeout"/"unreachable"
        # → current parser falls through to generic "No response".
        assert r["error"] == "No response"

    def test_macos_dns_failure_no_rtt(self, ping_fixture):
        out = ping_fixture("macos_dns_fail_en.txt")
        r = parse_ping_output(out, "Darwin")
        assert r["success"] is False
        assert r["rtt_ms"] is None
        # "cannot resolve" is not one of the known phrases → "No response".
        assert r["error"] == "No response"

    def test_linux_timeout_no_rtt(self, ping_fixture):
        out = ping_fixture("linux_timeout_en.txt")
        r = parse_ping_output(out, "Linux")
        assert r["success"] is False
        assert r["rtt_ms"] is None
        assert r["error"] == "No response"

    def test_linux_unreachable_recognised(self, ping_fixture):
        out = ping_fixture("linux_unreachable_en.txt")
        r = parse_ping_output(out, "Linux")
        assert r["success"] is False
        assert r["rtt_ms"] is None
        assert r["error"] == "Host unreachable"


# --- KNOWN BUGS (captured to detect accidental fixes) -------------------------


class TestKnownBugs:
    """These tests document parser BUGS in the current behaviour.

    They will FAIL when the parser is fixed in Sprint 2+. When that happens,
    delete the test, link the fix in the commit message, and add a positive
    test asserting the correct behaviour.
    """

    def test_macos_short_wait_misreports_as_no_response(self, ping_fixture):
        """macOS `-W <ms>` reply arrives outside wait window. The summary
        confirms `1 packets received, 0.0% packet loss`, but the per-packet
        `time=` line is missing → parser cannot extract RTT and reports
        failure even though the host was reachable.

        Root cause: Francesco's `build_ping_command()` passes `-W 2` which is
        seconds on Linux but milliseconds on macOS. Sprint 2 should fix the
        builder, not the parser.
        """
        out = ping_fixture("macos_success_en.txt")
        r = parse_ping_output(out, "Darwin")
        assert r["success"] is False  # ← bug
        assert r["error"] == "No response"

    def test_linux_italian_locale_not_recognised(self, ping_fixture):
        """Italian Linux locale emits `tempo=` instead of `time=`. The
        current Unix branch matches only `time=`. Result: a healthy ping
        is reported as failure on Italian-locale Linux hosts.

        Root cause: Italian regex exists only in the Windows branch.
        Sprint 2 should add `tempo=` to the Unix branch (or force LC_ALL=C
        in the subprocess env).
        """
        out = ping_fixture("linux_success_it.txt")
        r = parse_ping_output(out, "Linux")
        assert r["success"] is False  # ← bug
        assert r["error"] == "No response"

    def test_windows_italian_timeout_grammatical_mismatch(self):
        """Real Windows-IT output for a timed-out request is
        `Richiesta scaduta.` (feminine, because `richiesta` is feminine).
        The parser checks for the masculine form `"scaduto"` only, so a
        real IT-locale timeout falls through to the generic "No response".

        Sprint 2 should match both `scaduto` and `scaduta` (or use
        `scadut[oa]`).
        """
        out = "Richiesta scaduta.\n"
        r = parse_ping_output(out, "Windows")
        assert r["success"] is False
        assert r["error"] == "No response"  # ← bug; should be "Request timed out"


# --- Windows branch (synthetic, no real captures) -----------------------------


class TestWindowsBranch:
    """Smoke-tests for the Windows branch. We do not deploy to Windows, so
    these stay synthetic — keep them so refactors do not silently drop the
    branch."""

    def test_windows_english_success(self):
        out = "Reply from 8.8.8.8: bytes=32 time=14ms TTL=118\n"
        r = parse_ping_output(out, "Windows")
        assert r["success"] is True
        assert r["rtt_ms"] == 14.0

    def test_windows_italian_success(self):
        out = "Risposta da 8.8.8.8: byte=32 tempo=14ms TTL=118\n"
        r = parse_ping_output(out, "Windows")
        assert r["success"] is True
        assert r["rtt_ms"] == 14.0

    def test_windows_unreachable_english(self):
        out = "Reply from 192.168.1.1: Destination host unreachable.\n"
        r = parse_ping_output(out, "Windows")
        assert r["success"] is False
        assert r["error"] == "Host unreachable"

    def test_windows_timeout_italian_masculine_form(self):
        """The parser only matches the masculine form `"scaduto"`. This
        test exercises that path. The grammatically correct feminine
        form ``Richiesta scaduta`` is a known bug — see
        TestKnownBugs.test_windows_italian_timeout_grammatical_mismatch.
        """
        out = "Tempo scaduto.\n"  # masculine subject, matches parser
        r = parse_ping_output(out, "Windows")
        assert r["success"] is False
        assert r["error"] == "Request timed out"


# --- Defensive smoke -----------------------------------------------------------


class TestEdgeCases:
    def test_empty_output_unix(self):
        r = parse_ping_output("", "Linux")
        assert r == {"rtt_ms": None, "success": False, "error": "No response"}

    def test_empty_output_windows(self):
        r = parse_ping_output("", "Windows")
        assert r == {"rtt_ms": None, "success": False, "error": "No response"}
