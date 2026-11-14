import unittest
import geometry

class T(unittest.TestCase):
    def test_constant(self):
        self.assertEqual(geometry.PI, 3.14159)
        with open('geometry.py') as handle:
            self.assertEqual(handle.read().count('3.14159'), 1)

    def test_behaviour(self):
        self.assertAlmostEqual(geometry.circle_area(2), 12.56636)
        self.assertAlmostEqual(geometry.circle_perimeter(2), 12.56636)
        self.assertAlmostEqual(geometry.sphere_volume(1), 4.188786666)
