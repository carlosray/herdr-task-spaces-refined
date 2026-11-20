import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("layout_installer", Path(__file__).parents[1] / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class LocalCodeTests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.source = root / "release"
        self.base = root / "pristine"
        self.stage = root / "stage"
        self.stage.mkdir()
        self.relative = Path("mods/example/main.js")
        self.target = root / "installed.js"
        self.package = self.source / self.relative
        self.package.parent.mkdir(parents=True)
        override = patch.object(installer, "ROOT", self.source)
        override.start()
        self.addCleanup(override.stop)

    def prepare(self):
        return installer.stage_local_code({self.relative: self.target}, self.base, self.stage)

    def previous(self, content):
        file = self.base / self.relative
        file.parent.mkdir(parents=True)
        file.write_text(content)

    def test_first_install_preserves_custom_code_and_leaves_new_files_to_the_release(self):
        self.package.write_text("release\n")
        self.assertEqual(self.prepare(), {})
        self.target.write_text("personal\n")
        prepared = self.prepare()
        self.assertEqual(prepared[self.relative].read_text(), "personal\n")
        self.assertEqual(self.target.read_text(), "personal\n")

    def test_subsequent_release_merges_independent_changes(self):
        original = "name = 'global'\n\n// Separator.\n\nversion = 1\n"
        self.previous(original)
        self.target.write_text(original.replace("'global'", "'local'"))
        self.package.write_text(original.replace("version = 1", "version = 2"))
        merged = self.prepare()[self.relative].read_text()
        self.assertIn("name = 'local'", merged)
        self.assertIn("version = 2", merged)
        self.assertIn("version = 1", self.target.read_text())

    def test_conflicting_changes_fail_before_overwriting_any_file(self):
        self.previous("name = 'global'\n")
        self.target.write_text("name = 'local'\n")
        self.package.write_text("name = 'next'\n")
        with self.assertRaisesRegex(SystemExit, r"installed\.js"):
            self.prepare()
        self.assertEqual(self.target.read_text(), "name = 'local'\n")


if __name__ == "__main__":
    main()
