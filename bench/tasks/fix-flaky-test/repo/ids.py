import random

ALPHABET = 'abcdef0123456789'


def new_id(length=8, rng=random):
    return ''.join(rng.choice(ALPHABET) for _ in range(length))
