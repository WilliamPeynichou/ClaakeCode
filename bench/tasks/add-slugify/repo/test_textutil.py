import unittest
import textutil


class SlugifyTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(textutil.slugify("Hello World"), "hello-world")

    def test_separators(self):
        self.assertEqual(textutil.slugify("  A__b -- c!  "), "a-b-c")

    def test_digits(self):
        self.assertEqual(textutil.slugify("Version 2.0"), "version-2-0")

    def test_shout_unchanged(self):
        self.assertEqual(textutil.shout("hi"), "HI!")
