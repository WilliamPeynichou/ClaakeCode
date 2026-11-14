import unittest
import roman

class T(unittest.TestCase):
    def test_values(self):
        for number, text in [(1, 'I'), (4, 'IV'), (9, 'IX'), (14, 'XIV'), (40, 'XL'), (1994, 'MCMXCIV'), (3999, 'MMMCMXCIX')]:
            self.assertEqual(roman.to_roman(number), text)

    def test_range(self):
        for bad in (0, 4000):
            with self.assertRaises(ValueError):
                roman.to_roman(bad)
