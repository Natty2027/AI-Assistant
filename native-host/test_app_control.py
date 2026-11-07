"""Tests for app-control.py. No real apps are touched: the process runner, the app folders and the
clock are all injected.   python3 -m unittest discover -s native-host -p 'test_*.py'
"""
import importlib.util
import os
import plistlib
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("app_control", os.path.join(HERE, "app-control.py"))
ac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac)


def make_app(root, name, bundle_id, **extra):
    path = os.path.join(root, name + ".app")
    os.makedirs(os.path.join(path, "Contents"))
    with open(os.path.join(path, "Contents", "Info.plist"), "wb") as fh:
        plistlib.dump({"CFBundleIdentifier": bundle_id, "CFBundleName": name, **extra}, fh)
    return path


class FakeRunner:
    """Records every call and answers from a script. `ps_lines` is what `ps` reports running."""

    def __init__(self):
        self.calls = []
        self.ps_lines = []
        self.osascript = SimpleNamespace(returncode=0, stderr="")
        self.open_result = SimpleNamespace(returncode=0, stderr="")
        self.raise_on = {}

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        key = argv[0]
        if key in self.raise_on:
            raise self.raise_on[key]
        if key == "/bin/ps":
            return SimpleNamespace(returncode=0, stdout="\n".join(self.ps_lines), stderr="")
        if key == "/usr/bin/open":
            return self.open_result
        if key == "/usr/bin/osascript":
            return self.osascript
        raise AssertionError("unexpected process: %r" % (argv,))

    def commands(self):
        return [c[0] for c in self.calls if c[0] != "/bin/ps"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.calc = make_app(self.root, "Calculator", "com.apple.calculator")
        self.zoom = make_app(self.root, "zoom.us", "us.zoom.xos", CFBundleDisplayName="Zoom")
        self.runner = FakeRunner()
        self.now = [0.0]
        self.ctl = ac.AppControl(runner=self.runner, app_dirs=(self.root,), clock=lambda: self.now[0],
                                 platform="darwin", sleep=lambda s: None)


class Discovery(Base):
    def test_lists_installed_apps_sorted_with_display_names(self):
        res = self.ctl.handle({"op": "list"})
        self.assertTrue(res["ok"])
        self.assertEqual([a["name"] for a in res["apps"]], ["Calculator", "Zoom"])
        self.assertEqual(res["apps"][1]["id"], "us.zoom.xos")

    def test_background_agents_and_menu_bar_helpers_are_hidden(self):
        make_app(self.root, "Helper", "com.example.helper", LSBackgroundOnly=True)
        make_app(self.root, "Menubar", "com.example.menubar", LSUIElement=True)
        names = [a["name"] for a in self.ctl.handle({"op": "list"})["apps"]]
        self.assertNotIn("Helper", names)
        self.assertNotIn("Menubar", names)

    def test_apps_with_an_unsafe_bundle_id_are_never_offered(self):
        make_app(self.root, "Evil", 'x" to quit\ndo shell script "rm -rf ~')
        make_app(self.root, "Spacey", "has space.id")
        ids = [a["id"] for a in self.ctl.handle({"op": "list"})["apps"]]
        self.assertEqual(sorted(ids), ["com.apple.calculator", "us.zoom.xos"])

    def test_a_broken_bundle_is_skipped_not_fatal(self):
        os.makedirs(os.path.join(self.root, "Broken.app", "Contents"))
        self.assertTrue(self.ctl.handle({"op": "list"})["ok"])

    def test_apps_one_folder_down_are_found_but_not_deeper(self):
        suite = os.path.join(self.root, "Some Suite")
        os.makedirs(suite)
        make_app(suite, "Writer", "com.suite.writer")
        deep = os.path.join(suite, "Deeper")
        os.makedirs(deep)
        make_app(deep, "TooDeep", "com.suite.toodeep")
        ids = [a["id"] for a in self.ctl.handle({"op": "list"})["apps"]]
        self.assertIn("com.suite.writer", ids)
        self.assertNotIn("com.suite.toodeep", ids)

    def test_running_state_comes_from_processes_inside_the_bundle(self):
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us", "/usr/sbin/cfprefsd"]
        by = {a["id"]: a["running"] for a in self.ctl.handle({"op": "list"})["apps"]}
        self.assertEqual(by, {"com.apple.calculator": False, "us.zoom.xos": True})

    def test_a_similarly_named_path_does_not_count_as_running(self):
        self.runner.ps_lines = [self.zoom + "Helper/Contents/MacOS/x"]  # sibling path, not inside the bundle
        by = {a["id"]: a["running"] for a in self.ctl.handle({"op": "list"})["apps"]}
        self.assertFalse(by["us.zoom.xos"])


class Opening(Base):
    def test_open_uses_an_argument_list_with_the_bundle_id(self):
        res = self.ctl.handle({"op": "open", "id": "us.zoom.xos"})
        self.assertEqual(res, {"ok": True, "name": "Zoom"})
        self.assertEqual(self.runner.commands(), ["/usr/bin/open"])
        self.assertEqual(self.runner.calls[-1], ["/usr/bin/open", "-b", "us.zoom.xos"])

    def test_an_app_that_was_not_discovered_cannot_be_opened(self):
        res = self.ctl.handle({"op": "open", "id": "com.example.nothere"})
        self.assertEqual(res["error"], "unknown_app")
        self.assertEqual(self.runner.commands(), [])

    def test_open_failure_is_reported_not_swallowed(self):
        self.runner.open_result = SimpleNamespace(returncode=1, stderr="nope")
        self.assertEqual(self.ctl.handle({"op": "open", "id": "us.zoom.xos"})["error"], "failed")

    def test_open_timeout_is_reported(self):
        self.runner.raise_on["/usr/bin/open"] = subprocess.TimeoutExpired("open", 10)
        self.assertEqual(self.ctl.handle({"op": "open", "id": "us.zoom.xos"})["error"], "timed_out")


class Quitting(Base):
    def test_quit_asks_the_app_politely_with_its_own_quit(self):
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us"]
        seen = {"n": 0}
        real = self.runner.__call__

        def runner(argv, **kw):                       # the app really goes away after the quit request
            if argv[0] == "/usr/bin/osascript":
                self.runner.ps_lines = []
            return real(argv, **kw)
        self.ctl._run = runner
        res = self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})
        self.assertEqual(res, {"ok": True, "name": "Zoom", "closed": True})
        scripts = [c for c in self.runner.calls if c[0] == "/usr/bin/osascript"]
        self.assertEqual(scripts, [["/usr/bin/osascript", "-e", 'tell application id "us.zoom.xos" to quit']])

    def test_there_is_no_force_kill_path_at_all(self):
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us"]
        self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})
        used = " ".join(" ".join(c) for c in self.runner.calls)
        for forbidden in ("kill", "-9", "SIGKILL", "pkill", "killall"):
            self.assertNotIn(forbidden, used)

    def test_an_app_that_ignores_the_request_is_reported_as_not_closed(self):
        # e.g. a Save dialog is waiting for the user: asking succeeded, closing has not happened.
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us"]
        res = self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})
        self.assertTrue(res["ok"])
        self.assertFalse(res["closed"])

    def test_quitting_something_that_is_not_running_is_a_harmless_success(self):
        res = self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})
        self.assertEqual(res["already_closed"], True)
        self.assertNotIn("/usr/bin/osascript", self.runner.commands())

    def test_a_macos_permission_denial_is_named_so_the_user_can_act(self):
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us"]
        self.runner.osascript = SimpleNamespace(returncode=1, stderr="execution error: Not authorized to send Apple events (-1743)")
        self.assertEqual(self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})["error"], "permission_needed")

    def test_an_unanswered_permission_prompt_times_out_as_permission_needed(self):
        self.runner.ps_lines = [self.zoom + "/Contents/MacOS/zoom.us"]
        self.runner.raise_on["/usr/bin/osascript"] = subprocess.TimeoutExpired("osascript", 10)
        self.assertEqual(self.ctl.handle({"op": "quit", "id": "us.zoom.xos"})["error"], "permission_needed")


class Protection(Base):
    def test_browsers_finder_and_system_ui_can_never_be_quit(self):
        protected = {
            "com.google.Chrome": "Chrome", "com.google.Chrome.canary": "Chrome Canary",
            "com.microsoft.edgemac": "Edge", "org.mozilla.firefox": "Firefox", "com.apple.Safari": "Safari",
            "com.brave.Browser": "Brave", "company.thebrowser.Browser": "Arc",
            "com.apple.finder": "Finder", "com.apple.dock": "Dock", "com.apple.loginwindow": "loginwindow",
        }
        for bid, name in protected.items():
            path = make_app(self.root, name, bid)
            self.runner.ps_lines.append(path + "/Contents/MacOS/x")
        self.ctl._apps = None
        for bid in protected:
            res = self.ctl.handle({"op": "quit", "id": bid})
            self.assertEqual(res["error"], "protected", bid)
        self.assertNotIn("/usr/bin/osascript", self.runner.commands(), "a protected app must never reach osascript")

    def test_protected_apps_are_flagged_in_the_list_so_the_ui_can_say_why(self):
        make_app(self.root, "Chrome", "com.google.Chrome")
        self.ctl._apps = None
        by = {a["id"]: a["protected"] for a in self.ctl.handle({"op": "list"})["apps"]}
        self.assertTrue(by["com.google.Chrome"])
        self.assertFalse(by["us.zoom.xos"])

    def test_protected_apps_may_still_be_opened(self):
        make_app(self.root, "Chrome", "com.google.Chrome")
        self.ctl._apps = None
        self.assertTrue(self.ctl.handle({"op": "open", "id": "com.google.Chrome"})["ok"])


class Hostile(Base):
    def test_injection_attempts_in_the_id_are_refused_before_any_process_runs(self):
        for evil in ['x" to quit\ndo shell script "id"', "a; rm -rf ~", "$(whoami)", "../../etc/passwd",
                     "us.zoom.xos' ; echo", "", " ", "a" * 500, "us.zoom.xos\n"]:
            for op in ("open", "quit"):
                self.now[0] += ac.RATE_WINDOW_S + 1   # keep the rate limiter out of the way: this tests validation
                res = self.ctl.handle({"op": op, "id": evil})
                self.assertFalse(res["ok"], repr(evil))
                self.assertIn(res["error"], ("bad_id", "unknown_app"), repr(evil))
        self.assertEqual(self.runner.commands(), [])

    def test_the_second_guard_holds_even_if_discovery_were_fooled(self):
        # Defence in depth. Discovery filters unsafe bundle ids, and the action path re-checks the
        # id before use. Plant a hostile entry directly, as if discovery had let it through, and
        # confirm the second check still stops it reaching a process.
        evil = 'x" to quit\ndo shell script "touch /tmp/PWNED'
        self.ctl.apps()  # populate
        self.ctl._apps[evil] = {"id": evil, "name": "Evil", "path": os.path.join(self.root, "Evil.app")}
        self.runner.ps_lines = [os.path.join(self.root, "Evil.app", "Contents", "MacOS", "x")]
        for op in ("open", "quit"):
            self.now[0] += ac.RATE_WINDOW_S + 1
            self.assertEqual(self.ctl.handle({"op": op, "id": evil})["error"], "bad_id")
        self.assertEqual(self.runner.commands(), [])

    def test_a_flood_of_bad_requests_is_itself_rate_limited(self):
        errors = [self.ctl.handle({"op": "open", "id": "../x"})["error"] for _ in range(ac.RATE_MAX_OPS + 5)]
        self.assertEqual(errors[-1], "rate_limited")

    def test_non_string_ids_and_malformed_messages_are_refused(self):
        for bad in (None, 5, ["us.zoom.xos"], {"a": 1}, True):
            self.assertEqual(self.ctl.handle({"op": "open", "id": bad})["error"], "bad_id")
        for msg in (None, "open", 7, [], {"op": None}, {"op": "format-disk"}, {}):
            self.assertFalse(self.ctl.handle(msg)["ok"])
        self.assertEqual(self.runner.commands(), [])

    def test_the_caller_cannot_supply_a_path_or_a_command(self):
        res = self.ctl.handle({"op": "open", "id": "us.zoom.xos", "path": "/bin/sh", "argv": ["sh"], "cmd": "id"})
        self.assertTrue(res["ok"])
        self.assertEqual(self.runner.calls[-1], ["/usr/bin/open", "-b", "us.zoom.xos"])

    def test_rapid_repeated_requests_are_rate_limited_and_recover(self):
        results = [self.ctl.handle({"op": "open", "id": "us.zoom.xos"}) for _ in range(ac.RATE_MAX_OPS + 3)]
        self.assertEqual([r["ok"] for r in results[:ac.RATE_MAX_OPS]], [True] * ac.RATE_MAX_OPS)
        self.assertEqual(results[-1]["error"], "rate_limited")
        self.now[0] += ac.RATE_WINDOW_S + 1
        self.assertTrue(self.ctl.handle({"op": "open", "id": "us.zoom.xos"})["ok"])

    def test_listing_is_not_counted_against_the_action_limit(self):
        for _ in range(50):
            self.assertTrue(self.ctl.handle({"op": "list"})["ok"])
        self.assertTrue(self.ctl.handle({"op": "open", "id": "us.zoom.xos"})["ok"])


class Platforms(unittest.TestCase):
    def test_windows_and_linux_say_unsupported_instead_of_guessing(self):
        runner = FakeRunner()
        for plat in ("win32", "linux"):
            ctl = ac.AppControl(runner=runner, platform=plat)
            for op in ({"op": "list"}, {"op": "open", "id": "x.y"}, {"op": "quit", "id": "x.y"}):
                res = ctl.handle(op)
                self.assertEqual(res["error"], "unsupported_platform")
        self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()
