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


def test_windows_address_map_from_powershell_json(monkeypatch) -> None:
    payload = """
    [
      {
        "InterfaceAlias": "Ethernet",
        "InterfaceIndex": 12,
        "IPv4Address": "192.168.10.25",
        "DefaultGateway": "192.168.10.1",
        "NetAdapterStatus": "Up"
      },
      {
        "InterfaceAlias": "Wi-Fi",
        "InterfaceIndex": 18,
        "IPv4Address": ["10.10.0.15"],
        "DefaultGateway": null,
        "NetAdapterStatus": "Up"
      }
    ]
    """
    monkeypatch.setattr(network.platform, "system", lambda: "Windows")
    monkeypatch.setattr(network, "_run", lambda _cmd: payload)

    assert network.detect_default_interface() == "Ethernet"
    assert network._interface_address_map() == {
        "Ethernet": ["192.168.10.25"],
        "Wi-Fi": ["10.10.0.15"],
    }


def test_windows_interface_snapshot_reports_adapter_aliases(monkeypatch) -> None:
    monkeypatch.setattr(network.platform, "system", lambda: "Windows")
    monkeypatch.setattr(network, "detect_default_interface", lambda: "Ethernet")
    monkeypatch.setattr(
        network,
        "_windows_address_map",
        lambda: {"Ethernet": ["192.168.10.25"], "Wi-Fi": ["10.10.0.15"]},
    )

    interfaces = network.list_network_interfaces()

    assert [iface.name for iface in interfaces] == ["Ethernet", "Wi-Fi"]
    assert interfaces[0].is_default is True
