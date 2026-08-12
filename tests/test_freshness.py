"""Tests for the should_write() commit-spam guard in fetch_cdc.py and
fetch_fng.py -- the only thing pinning the behaviour change that stops the
data-refresh workflows from committing on every run regardless of whether the
underlying reading actually changed.
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fetch_cdc
import fetch_fng

NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)


class ShouldWriteFNGTests(unittest.TestCase):
    def _payload(self, **overrides):
        base = {
            "generated": "2026-08-13T12:00:00Z",
            "update_time": "2026-08-13T11:55:00Z",
            "value": 38,
            "classification": "Fear",
        }
        base.update(overrides)
        return base

    def test_no_existing_file_writes(self):
        self.assertTrue(fetch_fng.should_write(None, self._payload(), NOW))

    def test_identical_semantic_fresh_stamp_skips(self):
        old = self._payload(generated="2026-08-13T11:00:00Z")  # 1h old
        new = self._payload(update_time="2026-08-13T11:58:00Z")  # differs, non-semantic
        self.assertFalse(fetch_fng.should_write(old, new, NOW))

    def test_identical_semantic_stale_stamp_heartbeats(self):
        old = self._payload(generated="2026-08-12T15:00:00Z")  # 21h old
        new = self._payload()
        self.assertTrue(fetch_fng.should_write(old, new, NOW))

    def test_value_changed_writes(self):
        old = self._payload(value=40)
        new = self._payload(value=38)
        self.assertTrue(fetch_fng.should_write(old, new, NOW))

    def test_classification_changed_writes(self):
        old = self._payload(classification="Neutral")
        new = self._payload(classification="Fear")
        self.assertTrue(fetch_fng.should_write(old, new, NOW))

    def test_update_time_alone_does_not_force_write(self):
        # update_time changes on almost every CMC poll regardless of whether
        # the index moved -- it must not be a semantic field
        old = self._payload(update_time="2026-08-13T05:55:00Z", generated="2026-08-13T11:00:00Z")
        new = self._payload(update_time="2026-08-13T11:55:00Z")
        self.assertFalse(fetch_fng.should_write(old, new, NOW))

    def test_missing_generated_writes(self):
        old = {"value": 38, "classification": "Fear"}
        new = self._payload()
        self.assertTrue(fetch_fng.should_write(old, new, NOW))

    def test_malformed_generated_writes(self):
        old = self._payload(generated="not-a-timestamp")
        new = self._payload()
        self.assertTrue(fetch_fng.should_write(old, new, NOW))


class ShouldWriteCDCTests(unittest.TestCase):
    def _payload(self, **overrides):
        base = {
            "generated": "2026-08-13T00:05:00Z",
            "blocks": [{"bull": True, "today": True, "diff": 1.23}],
        }
        base.update(overrides)
        return base

    def test_identical_blocks_fresh_stamp_skips(self):
        old = self._payload(generated="2026-08-13T00:00:00Z")  # a few min old
        new = self._payload()
        self.assertFalse(fetch_cdc.should_write(old, new, NOW))

    def test_identical_blocks_stale_stamp_heartbeats(self):
        old = self._payload(generated="2026-08-12T14:00:00Z")  # 22h old
        new = self._payload()
        self.assertTrue(fetch_cdc.should_write(old, new, NOW))

    def test_blocks_changed_writes(self):
        old = self._payload(blocks=[{"bull": False, "today": True, "diff": 1.23}])
        new = self._payload()
        self.assertTrue(fetch_cdc.should_write(old, new, NOW))


class ReadExistingTests(unittest.TestCase):
    def test_nonexistent_path_returns_none(self):
        self.assertIsNone(fetch_fng.read_existing(Path("/nonexistent/path/fng.js")))

    def test_valid_file_parses(self, tmp_path=None):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "fng.js"
            p.write_text('// comment\nwindow.LOCAL_FNG = {"value": 38, "classification": "Fear"};\n')
            result = fetch_fng.read_existing(p)
            self.assertEqual(result, {"value": 38, "classification": "Fear"})

    def test_truncated_file_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "fng.js"
            p.write_text('// comment\nwindow.LOCAL_FNG = {"value": 38, "classif')
            self.assertIsNone(fetch_fng.read_existing(p))


if __name__ == "__main__":
    unittest.main()
