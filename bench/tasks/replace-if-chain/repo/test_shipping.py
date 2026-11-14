import unittest
import shipping

class T(unittest.TestCase):
    def test_table(self):
        self.assertEqual(shipping.RATES, {'FR': 5, 'BE': 7, 'DE': 8, 'US': 15})
        with open('shipping.py') as handle:
            self.assertNotIn('elif', handle.read())

    def test_behaviour(self):
        self.assertEqual([shipping.shipping_cost(c) for c in ('FR', 'BE', 'DE', 'US', 'JP')], [5, 7, 8, 15, 20])
