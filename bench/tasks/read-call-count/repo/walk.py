TREE = {'a': {'b': {}, 'c': {'d': {}, 'e': {}}}, 'f': {}}
CALLS = []


def visit(name):
    CALLS.append(name)


def walk(tree):
    for name, children in tree.items():
        visit(name)
        walk(children)
