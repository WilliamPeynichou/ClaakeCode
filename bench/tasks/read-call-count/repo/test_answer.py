import unittest
import os
import walk

class T(unittest.TestCase):
    def test_answer(self):
        self.assertTrue(os.path.exists('answer.txt'), 'answer.txt is missing')
        walk.walk(walk.TREE)
        with open('answer.txt') as handle:
            self.assertEqual(handle.read().strip(), str(len(walk.CALLS)))
