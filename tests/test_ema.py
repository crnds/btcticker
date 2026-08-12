"""Golden-vector tests for fetch_cdc.calc_ema and the CDC block builder.

The fixture (tests/fixtures/ema_golden.json) is frozen -- it is not generated
by this test run, so a real algorithmic regression in calc_ema fails these
tests instead of silently updating the "truth" alongside the bug. See the
fixture's own _comment field for the full rationale.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fetch_cdc  # noqa: E402  (path must be set up first)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ema_golden.json").read_text())
TOLERANCE = FIXTURE["tolerance"]


class TestCalcEMA(unittest.TestCase):
    def test_golden_vectors(self):
        for case in FIXTURE["ema"]:
            with self.subTest(name=case["name"]):
                actual = fetch_cdc.calc_ema(case["closes"], case["period"])
                expected = case["expected"]
                self.assertEqual(len(actual), len(expected), case["name"])
                for i, (a, e) in enumerate(zip(actual, expected)):
                    with self.subTest(name=case["name"], index=i):
                        if e is None:
                            self.assertIsNone(a)
                        else:
                            self.assertAlmostEqual(a, e, delta=TOLERANCE)


class TestBlockBuilder(unittest.TestCase):
    def test_realistic_60d_blocks(self):
        case = FIXTURE["blocks"][0]
        closes = case["closes"]
        display = case["display"]
        ema12 = fetch_cdc.calc_ema(closes, 12)
        ema26 = fetch_cdc.calc_ema(closes, 26)

        # mirrors the exact loop in fetch_cdc.py:main()
        actual = []
        for i in range(len(closes) - display, len(closes)):
            actual.append({
                "bull": ema12[i] > ema26[i],
                "today": i == len(closes) - 1,
                "diff": round(abs(ema12[i] - ema26[i]), 2),
            })

        expected = case["expected"]
        self.assertEqual(len(actual), len(expected))
        for i, (a, e) in enumerate(zip(actual, expected)):
            with self.subTest(index=i):
                self.assertEqual(a["bull"], e["bull"])
                self.assertEqual(a["today"], e["today"])
                self.assertAlmostEqual(a["diff"], round(e["diff"], 2), delta=TOLERANCE)

    def test_has_a_crossover(self):
        # sanity check on the fixture itself, not the implementation: a fixture
        # with no bull/bear transition wouldn't exercise the interesting path
        blocks = FIXTURE["blocks"][0]["expected"]
        bulls = [b["bull"] for b in blocks]
        crossovers = sum(1 for i in range(1, len(bulls)) if bulls[i] != bulls[i - 1])
        self.assertGreaterEqual(crossovers, 1)


if __name__ == "__main__":
    unittest.main()
