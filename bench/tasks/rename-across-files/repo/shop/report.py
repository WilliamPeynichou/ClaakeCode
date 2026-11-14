from shop import totals


def report(prices):
    return 'Total: %d' % totals.calc(prices)
