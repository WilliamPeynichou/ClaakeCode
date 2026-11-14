import unittest
from pricing import rules
from pricing.checkout import checkout

class T(unittest.TestCase):
    def test_rule(self):
        self.assertEqual(rules.apply_discount(200, 25), 150.0)
        with self.assertRaises(ValueError):
            rules.apply_discount(10, 101)

    def test_checkout(self):
        self.assertEqual(checkout([50, 50]), 120.0)
        self.assertEqual(checkout([50, 50], discount=50), 60.0)
