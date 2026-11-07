#!/usr/bin/env python3
"""Native messaging host — reads real OS Do Not Disturb / Focus / Quiet Hours.

Optional. Without it, quietMode.ts loses the `os_focus` evidence source and falls back to
calendar plus page heuristics, defaulting to quiet. Nothing breaks; the app guesses more
conservatively.

Supported: macOS 12+, Windows 10+, Linux (GNOME/KDE). Not iOS — there is no native
messaging on iOS, and no API that exposes Focus state to a browser.

Install: see INSTALL.md
"""

import json
import os
import struct
import subprocess
import sys


# ---------------------------------------------------------------- probes

def macos_focus():
    path = os.path.expanduser("~/Library/DoNotDisturb/DB/Assertions.json")
    try:
        with open(path) as fh:
            data = json.load(fh)
        records = (data.get("data") or [{}])[0].get("storeAssertionRecords") or []
        if not records:
            return False, None
        detail = records[0].get("assertionDetails", {})
        mode = detail.get("assertionDetailsModeIdentifier", "Focus")
        return True, mode.split(".")[-1].replace("-", " ").title()
    except (OSError, ValueError, KeyError, IndexError):
        return False, None


def windows_quiet_hours():
    """SHQueryUserNotificationState — the documented way to read Focus Assist."""
    try:
        import ctypes
        state = ctypes.c_int()
        hr = ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state))
        if hr != 0:                       # non-zero HRESULT => value is meaningless
            return False, None
        names = {2: "Busy", 3: "Fullscreen app", 4: "Presenting", 6: "Focus assist"}
        return state.value in names, names.get(state.value)
    except (ImportError, AttributeError, OSError):
        return False, None


def linux_dnd():
    try:
        out = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.notifications", "show-banners"],
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0:
            # Label only when actually active — a mode_name alongside focus_active=False
            # reads as a contradiction in the panel header.
            active = out.stdout.strip() == "false"
            return active, "Do Not Disturb" if active else None
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        with open(os.path.expanduser("~/.config/plasmanotifyrc")) as fh:
            if "DoNotDisturb" in fh.read():
                return True, "Do Not Disturb"
    except OSError:
        pass
    return False, None


def probe():
    if sys.platform == "darwin":
        active, label = macos_focus()
    elif sys.platform.startswith("win"):
        active, label = windows_quiet_hours()
    elif sys.platform.startswith("linux"):
        active, label = linux_dnd()
    else:
        active, label = False, None
    return {"focus_active": active, "mode_name": label, "platform": sys.platform}


# ---------------------------------------------------------------- transport

def _use_binary_stdio():
    r"""Windows translates \n to \r\n on text-mode streams.

    Native messaging frames a 4-byte little-endian length ahead of the payload. If any byte
    of that header or the JSON is 0x0A, text mode corrupts it and the browser sees a
    malformed frame. It presents as the host failing "randomly" on Windows only — whenever
    the payload length happens to land on the wrong value. Both streams must be binary
    before a single byte moves.
    """
    if sys.platform.startswith("win"):
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    body = sys.stdin.buffer.read(length)
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        return {}


def write_message(payload):
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    _use_binary_stdio()
    # The browser may keep the host alive across several queries; loop, don't exit after one.
    while True:
        msg = read_message()
        if msg is None:
            return
        write_message(probe())


if __name__ == "__main__":
    main()
