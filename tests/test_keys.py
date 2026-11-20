import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("layout_installer", Path(__file__).parents[1] / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class KeyBindingsTests(TestCase):
    def test_install_leaves_ctrl_w_to_the_terminal_and_preserves_user_bindings(self):
        scope = f"layout:{installer.LAYOUT}"
        options = SimpleNamespace(no_automations=True, no_wrapper=True, no_instructions=True, no_hooks=True)
        for existing, expected in ((None, None), ("better-tabs-refined.close-tab", None), ("terminal", "terminal")):
            with self.subTest(existing=existing), TemporaryDirectory() as folder:
                home = Path(folder)
                path = home / "keys.json"
                original = {
                    scope: {"cmd-w": "tab.close"},
                    "global": {"alt-w": "app.palette"},
                }
                if existing is not None:
                    original[scope]["ctrl-w"] = existing
                path.write_text(json.dumps(original))

                with patch.dict(os.environ, {"HERDR_APP_HOME": folder}), patch.object(installer, "ensure_dependencies"):
                    installer.desktop_install(home, home / "backup", options, {})

                installed = json.loads(path.read_text())
                self.assertEqual(installed[scope].get("ctrl-w"), expected)
                self.assertEqual(installed[scope]["cmd-w"], "tab.close")
                self.assertEqual(installed[scope]["cmd-shift-w"], "better-tabs-refined.close-pane")
                self.assertEqual(installed["global"], original["global"])
