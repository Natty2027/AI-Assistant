#!/usr/bin/env python3
"""Native messaging host: list, open and gracefully quit desktop apps.

OPTIONAL and separate from quiet-probe.py on purpose. The Focus probe only reads state; this one
can launch and close programs, so it is a different level of trust and is installed, audited and
removed on its own. Without it the extension simply has no app control; nothing else changes.

What it will and will not do
  * It never runs a command it was handed. The extension sends {op, id}; `id` must be a bundle
    identifier that THIS host found by scanning the installed applications itself. Anything else
    is refused, and the id is checked against a strict pattern before it goes anywhere near a
    process call. No shell is ever involved.
  * "quit" is a polite request (the app's own Quit), so an app with unsaved work can still ask
    the user to save. There is no force-kill path.
  * It refuses to quit the user's web browser (that would take this extension with it, and lose
    their tabs), the Finder, and core system UI, whatever the caller asks.
  * It is rate-limited, so a misbehaving caller cannot loop it.

Supported: macOS. Windows and Linux report "unsupported_platform" until they are implemented
and tested; shipping untested launch/quit code for them would be worse than saying so.

Install: see INSTALL-app-control.md
"""

import json
import os
import plistlib
import re
import struct
import subprocess
import sys
import time
from collections import deque

HOST_NAME = "com.acc.appcontrol"

# A bundle identifier is dotted ASCII words. Anything outside this is not one, and since this
# string is interpolated into an AppleScript, the pattern is also what makes that safe.
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-]{0,127}$")

PROTECTED_IDS = {
    "com.apple.finder", "com.apple.dock", "com.apple.systemuiserver",
    "com.apple.loginwindow", "com.apple.controlcenter", "com.apple.notificationcenterui",
}
# Browsers: quitting one ends this extension and discards the user's open pages.
PROTECTED_PREFIXES = (
    "com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "com.apple.Safari",
    "com.brave.Browser", "org.chromium.Chromium", "company.thebrowser.Browser",
    "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
)

MAC_APP_DIRS = (
    "/Applications", "/Applications/Utilities", "/System/Applications",
    "/System/Applications/Utilities", os.path.expanduser("~/Applications"),
)

MAX_MESSAGE_BYTES = 64 * 1024
RATE_WINDOW_S = 30.0
RATE_MAX_OPS = 12
SUBPROCESS_TIMEOUT_S = 10


def is_protected(app_id):
    return app_id in PROTECTED_IDS or app_id.startswith(PROTECTED_PREFIXES)


class AppControl:
    """All behaviour lives here so tests can inject the process runner, the app folders and the clock."""

    def __init__(self, runner=subprocess.run, app_dirs=MAC_APP_DIRS, clock=time.monotonic,
                 platform=sys.platform, sleep=time.sleep):
        self._run = runner
        self._dirs = app_dirs
        self._clock = clock
        self._platform = platform
        self._sleep = sleep
        self._ops = deque()
        self._apps = None
        self._apps_at = 0.0

    # ------------------------------------------------------------ discovery

    def _scan(self):
        found = {}
        for base in self._dirs:
            try:
                entries = sorted(os.listdir(base))
            except OSError:
                continue
            candidates = [os.path.join(base, e) for e in entries if e.endswith(".app")]
            # One level of plain folders (e.g. /Applications/Some Suite/), never deeper.
            for e in entries:
                sub = os.path.join(base, e)
                if not e.endswith(".app") and os.path.isdir(sub):
                    try:
                        candidates += [os.path.join(sub, s) for s in sorted(os.listdir(sub)) if s.endswith(".app")]
                    except OSError:
                        pass
            for path in candidates[:2000]:
                info = self._read_plist(path)
                if info is None:
                    continue
                app_id = info.get("CFBundleIdentifier")
                # Background agents and menu-bar helpers are not things a person opens or closes.
                if info.get("LSBackgroundOnly") or info.get("LSUIElement"):
                    continue
                if not isinstance(app_id, str) or not ID_RE.match(app_id) or app_id in found:
                    continue
                name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or os.path.basename(path)[:-4]
                found[app_id] = {"id": app_id, "name": str(name), "path": path}
        return found

    @staticmethod
    def _read_plist(app_path):
        try:
            with open(os.path.join(app_path, "Contents", "Info.plist"), "rb") as fh:
                data = plistlib.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError, plistlib.InvalidFileException):
            return None

    def apps(self):
        now = self._clock()
        if self._apps is None or now - self._apps_at > 30:
            self._apps, self._apps_at = self._scan(), now
        return self._apps

    def _running_ids(self):
        """Which discovered apps have a live process, without needing any macOS permission."""
        try:
            out = self._run(["/bin/ps", "-axo", "comm="], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError):
            return set()
        lines = (out.stdout or "").splitlines()
        running = set()
        for app in self.apps().values():
            prefix = app["path"] + "/Contents/"
            if any(line.startswith(prefix) for line in lines):
                running.add(app["id"])
        return running

    # ------------------------------------------------------------ guards

    def _rate_limited(self):
        now = self._clock()
        while self._ops and now - self._ops[0] > RATE_WINDOW_S:
            self._ops.popleft()
        if len(self._ops) >= RATE_MAX_OPS:
            return True
        self._ops.append(now)
        return False

    def _resolve(self, app_id):
        """(app, None) for a usable id, or (None, error). The id must be one we discovered."""
        if not isinstance(app_id, str) or not ID_RE.match(app_id):
            return None, "bad_id"
        app = self.apps().get(app_id)
        if app is None:
            return None, "unknown_app"
        return app, None

    # ------------------------------------------------------------ operations

    def handle(self, msg):
        if self._platform != "darwin":
            return {"ok": False, "error": "unsupported_platform", "platform": self._platform}
        if not isinstance(msg, dict):
            return {"ok": False, "error": "bad_request"}
        op = msg.get("op")
        if op == "list":
            return self._list()
        if op in ("open", "quit"):
            if self._rate_limited():
                return {"ok": False, "error": "rate_limited"}
            app, err = self._resolve(msg.get("id"))
            if err:
                return {"ok": False, "error": err}
            return self._open(app) if op == "open" else self._quit(app)
        return {"ok": False, "error": "unknown_op"}

    def _list(self):
        running = self._running_ids()
        apps = [
            {"id": a["id"], "name": a["name"], "running": a["id"] in running, "protected": is_protected(a["id"])}
            for a in self.apps().values()
        ]
        apps.sort(key=lambda a: a["name"].lower())
        return {"ok": True, "apps": apps}

    def _open(self, app):
        try:
            # An argument list, never a shell string. `-b` addresses the app by bundle id.
            r = self._run(["/usr/bin/open", "-b", app["id"]], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "timed_out"}
        except (OSError, subprocess.SubprocessError):
            return {"ok": False, "error": "failed"}
        return {"ok": True, "name": app["name"]} if r.returncode == 0 else {"ok": False, "error": "failed"}

    def _quit(self, app):
        if is_protected(app["id"]):
            return {"ok": False, "error": "protected", "name": app["name"]}
        if app["id"] not in self._running_ids():
            return {"ok": True, "name": app["name"], "closed": True, "already_closed": True}
        # The app's own Quit, so it can still ask to save. `id` is regex-checked above, so it
        # cannot break out of the quotes.
        script = 'tell application id "%s" to quit' % app["id"]
        try:
            r = self._run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            # Usually a macOS "wants to control" prompt nobody has answered yet.
            return {"ok": False, "error": "permission_needed", "name": app["name"]}
        except (OSError, subprocess.SubprocessError):
            return {"ok": False, "error": "failed"}
        if r.returncode != 0:
            err = (r.stderr or "")
            denied = "-1743" in err or "not authorized" in err.lower()
            return {"ok": False, "error": "permission_needed" if denied else "failed", "name": app["name"]}
        # Asking is not the same as closing: an app with unsaved work may be waiting on the user.
        closed = False
        for _ in range(4):
            self._sleep(0.4)
            if app["id"] not in self._running_ids():
                closed = True
                break
        return {"ok": True, "name": app["name"], "closed": closed}


# ---------------------------------------------------------------- transport

def _use_binary_stdio():
    r"""Windows text mode would rewrite \n inside the length header; see quiet-probe.py."""
    if sys.platform.startswith("win"):
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    if length > MAX_MESSAGE_BYTES:
        sys.stdin.buffer.read(length)  # drain, then refuse
        return {"op": "__too_large__"}
    try:
        return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
    except ValueError:
        return {}


def write_message(payload):
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    _use_binary_stdio()
    control = AppControl()
    while True:
        msg = read_message()
        if msg is None:
            return
        write_message(control.handle(msg))


if __name__ == "__main__":
    main()
