import unittest
from cache import LRUCache

class T(unittest.TestCase):
    def test_eviction(self):
        cache = LRUCache(2)
        cache.put('a', 1)
        cache.put('b', 2)
        self.assertEqual(cache.get('a'), 1)
        cache.put('c', 3)
        self.assertIsNone(cache.get('b'))
        self.assertEqual(cache.get('a'), 1)
        self.assertEqual(cache.get('c'), 3)

    def test_update(self):
        cache = LRUCache(1)
        cache.put('a', 1)
        cache.put('a', 2)
        self.assertEqual(cache.get('a'), 2)
