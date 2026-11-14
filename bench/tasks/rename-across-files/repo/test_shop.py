import unittest
import glob
import re
from shop import cart, report, totals

class T(unittest.TestCase):
    def test_renamed(self):
        self.assertTrue(hasattr(totals, 'compute_total'))
        for path in glob.glob('shop/*.py'):
            with open(path) as handle:
                self.assertIsNone(re.search(r'\bcalc\b', handle.read()), path)

    def test_behaviour(self):
        self.assertEqual(cart.cart_total([{'price': 2}, {'price': 3}]), 5)
        self.assertEqual(report.report([1, 2]), 'Total: 3')
