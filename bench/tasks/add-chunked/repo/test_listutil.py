import unittest
import listutil

class T(unittest.TestCase):
    def test_chunks(self):
        self.assertEqual(listutil.chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_empty(self):
        self.assertEqual(listutil.chunked([], 3), [])

    def test_bad_size(self):
        with self.assertRaises(ValueError):
            listutil.chunked([1], 0)
