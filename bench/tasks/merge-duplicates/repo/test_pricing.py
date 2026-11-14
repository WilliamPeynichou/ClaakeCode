import unittest
import pricing


class PricingTest(unittest.TestCase):
    def test_single_function(self):
        self.assertTrue(hasattr(pricing, "price_with_tax"))
        self.assertFalse(hasattr(pricing, "price_with_tax_a"))
        self.assertFalse(hasattr(pricing, "price_with_tax_b"))

    def test_behaviour_kept(self):
        self.assertEqual(pricing.price_with_tax(100, 0.2), 120.0)
        self.assertEqual(pricing.invoice_total([10, 20, 30], 0.5), 90.0)
