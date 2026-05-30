"""Network-interface discovery and ping binding helpers."""

from __future__ import annotations

import platform
import re
import socket
import subprocess
from dataclasses import dataclass
from typing import Any

AUTO_INTERFACE = "auto"
_ENV = {"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


@dataclass(slots=True)
class NetworkInterface:
    name: str
    addresses: list[str]
    is_default: bool = False
    is_loopback: bool = False

    def to_dict(self) -> dict[str, Any]:
        label = self.name
        if self.addresses:
            label = f"{label} · {self.addresses[0]}"
        return {
            "name": self.name,
            "label": label,
            "addresses": self.addresses,
            "is_default": self.is_default,
            "is_loopback": self.is_loopback,
        }


def interface_snapshot(selected_name: str | None = None) -> dict[str, Any]:
    """Return UI-ready network interface state.

    ``selected='auto'`` means the ping command does not bind explicitly and the
    OS routing table decides. ``active`` still reports the current default
    interface so the hero can show what the server is likely using.
    """
    selected = normalize_interface_selection(selected_name)
    interfaces = list_network_interfaces()
    by_name = {iface.name: iface for iface in interfaces}
    default_name = detect_default_interface()
    if selected != AUTO_INTERFACE and selected not in by_name:
        selected = AUTO_INTERFACE

    active_name = default_name if selected == AUTO_INTERFACE else selected
    active_iface = by_name.get(active_name) if active_name else None
    if active_iface is None and selected != AUTO_INTERFACE:
        active_iface = by_name.get(selected)

    auto_label = "auto"
    if default_name:
        auto_label = f"auto · {default_name}"
        default_iface = by_name.get(default_name)
        if default_iface and default_iface.addresses:
            auto_label = f"{auto_label} · {default_iface.addresses[0]}"

    return {
        "selected": selected,
        "active": active_iface.to_dict() if active_iface else None,
        "interfaces": [
            {
                "name": AUTO_INTERFACE,
                "label": auto_label,
                "addresses": active_iface.addresses if active_iface else [],
                "is_default": True,
                "is_loopback": False,
            },
            *[iface.to_dict() for iface in interfaces],
        ],
    }


def normalize_interface_selection(name: str | None) -> str:
    selected = (name or AUTO_INTERFACE).strip()
    return selected or AUTO_INTERFACE


def ping_binding_for_selection(selected_name: str | None) -> tuple[str | None, str | None]:
    """Return ``(interface_name, source_address)`` for the ping scheduler."""
    selected = normalize_interface_selection(selected_name)
    if selected == AUTO_INTERFACE:
        return None, None
    return selected, source_address_for_interface(selected)


def list_network_interfaces() -> list[NetworkInterface]:
    default_name = detect_default_interface()
    address_map = _interface_address_map()
    names = _interface_names(address_map)
    interfaces: list[NetworkInterface] = []
    for name in names:
        addresses = address_map.get(name, [])
        if not addresses and name != default_name and not _is_loopback(name):
            continue
        interfaces.append(
            NetworkInterface(
                name=name,
                addresses=addresses,
                is_default=name == default_name,
                is_loopback=_is_loopback(name),
            )
        )
    interfaces.sort(key=lambda item: (not item.is_default, item.is_loopback, item.name))
    return interfaces


def detect_default_interface() -> str | None:
    os_name = platform.system()
    if os_name == "Darwin":
        out = _run(["route", "-n", "get", "default"])
        match = re.search(r"^\s*interface:\s*(\S+)", out, re.MULTILINE)
        return match.group(1) if match else None
    if os_name == "Linux":
        out = _run(["ip", "route", "get", "1.1.1.1"])
        match = re.search(r"\bdev\s+(\S+)", out)
        if match:
            return match.group(1)
        out = _run(["ip", "route", "show", "default"])
        match = re.search(r"\bdev\s+(\S+)", out)
        return match.group(1) if match else None
    return None


def source_address_for_interface(name: str | None) -> str | None:
    selected = normalize_interface_selection(name)
    if selected == AUTO_INTERFACE:
        return None
    addresses = _interface_address_map().get(selected, [])
    for address in addresses:
        if not address.startswith(("127.", "169.254.")):
            return address
    return addresses[0] if addresses else None


def _interface_names(address_map: dict[str, list[str]]) -> list[str]:
    names: list[str] = []
    try:
        names = [name for _, name in socket.if_nameindex()]
    except OSError:
        names = []
    for name in address_map:
        if name not in names:
            names.append(name)
    return names


def _interface_address_map() -> dict[str, list[str]]:
    os_name = platform.system()
    if os_name == "Linux":
        mapped = _linux_address_map()
        if mapped:
            return mapped
    if os_name == "Darwin":
        mapped = _darwin_address_map()
        if mapped:
            return mapped
    return _ifconfig_address_map()


def _linux_address_map() -> dict[str, list[str]]:
    out = _run(["ip", "-o", "-4", "addr", "show"])
    mapped: dict[str, list[str]] = {}
    for line in out.splitlines():
        match = re.search(r"^\d+:\s+([^:\s]+).*?\binet\s+([0-9.]+)/", line)
        if not match:
            continue
        name = match.group(1).split("@", 1)[0]
        mapped.setdefault(name, []).append(match.group(2))
    return mapped


def _darwin_address_map() -> dict[str, list[str]]:
    mapped: dict[str, list[str]] = {}
    try:
        names = [name for _, name in socket.if_nameindex()]
    except OSError:
        names = []
    for name in names:
        out = _run(["ipconfig", "getifaddr", name])
        address = out.strip()
        if address:
            mapped.setdefault(name, []).append(address)
    fallback = _ifconfig_address_map()
    for name, addresses in fallback.items():
        for address in addresses:
            if address not in mapped.setdefault(name, []):
                mapped[name].append(address)
    return mapped


def _ifconfig_address_map() -> dict[str, list[str]]:
    out = _run(["ifconfig"])
    mapped: dict[str, list[str]] = {}
    current: str | None = None
    for line in out.splitlines():
        header = re.match(r"^([A-Za-z0-9_.:-]+):\s", line)
        if header:
            current = header.group(1)
            mapped.setdefault(current, [])
            continue
        if current is None:
            continue
        match = re.search(r"\binet\s+([0-9.]+)", line)
        if match and not match.group(1).startswith("255."):
            mapped[current].append(match.group(1))
    return {name: addresses for name, addresses in mapped.items() if addresses}


def _is_loopback(name: str) -> bool:
    return name.startswith(("lo", "Loopback"))


def _run(cmd: list[str]) -> str:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            check=False,
            env=_ENV,
            text=True,
            timeout=0.8,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout
