import unittest
from ids import new_id

class T(unittest.TestCase):
    def test_new_id(self):
        value = new_id()
        self.assertEqual(len(value), 8)
        self.assertTrue(value[0].isdigit())
