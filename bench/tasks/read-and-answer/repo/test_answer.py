import os
import unittest
from sequence import mystery


class AnswerTest(unittest.TestCase):
    def test_answer_file(self):
        self.assertTrue(os.path.exists("answer.txt"), "answer.txt is missing")
        with open("answer.txt") as handle:
            self.assertEqual(handle.read().strip(), str(mystery(10)))
