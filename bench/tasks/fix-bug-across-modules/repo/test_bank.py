import unittest
from bank.report import monthly_report

class T(unittest.TestCase):
    def test_report(self):
        self.assertEqual(monthly_report(), ['rent: 800.00 EUR', 'food: 125.50 EUR', 'total: 925.50 EUR'])
