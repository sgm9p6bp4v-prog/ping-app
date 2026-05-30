from __future__ import annotations

from netping import network


def test_interface_snapshot_reports_auto_active(monkeypatch) -> None:
    monkeypatch.setattr(network, "detect_default_interface", lambda: "en0")
    monkeypatch.setattr(
        network,
        "list_network_interfaces",
        lambda: [
            network.NetworkInterface("en0", ["192.168.1.20"], is_default=True),
            network.NetworkInterface("lo0", ["127.0.0.1"], is_loopback=True),
        ],
    )

    snapshot = network.interface_snapshot("auto")

    assert snapshot["selected"] == "auto"
    assert snapshot["active"]["name"] == "en0"
    assert snapshot["interfaces"][0]["label"] == "auto · en0 · 192.168.1.20"


def test_interface_snapshot_falls_back_to_auto_for_missing_interface(monkeypatch) -> None:
    monkeypatch.setattr(network, "detect_default_interface", lambda: "en0")
    monkeypatch.setattr(
        network,
        "list_network_interfaces",
        lambda: [network.NetworkInterface("en0", ["192.168.1.20"], is_default=True)],
    )

    snapshot = network.interface_snapshot("old0")

    assert snapshot["selected"] == "auto"
    assert snapshot["active"]["name"] == "en0"
