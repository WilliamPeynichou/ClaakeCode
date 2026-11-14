import unittest
from words import count_words

class T(unittest.TestCase):
    def test_case_and_punctuation(self):
        self.assertEqual(count_words('The cat. the CAT!'), {'the': 2, 'cat': 2})

    def test_empty(self):
        self.assertEqual(count_words(''), {})
