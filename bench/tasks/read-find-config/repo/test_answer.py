import unittest
import os
from app.server import address

class T(unittest.TestCase):
    def test_answer(self):
        self.assertTrue(os.path.exists('answer.txt'), 'answer.txt is missing')
        os.environ.pop('APP_ENV', None)
        os.environ.pop('APP_PORT', None)
        with open('answer.txt') as handle:
            self.assertEqual(handle.read().strip(), str(address()[1]))
