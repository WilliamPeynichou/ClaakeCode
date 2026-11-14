from pricing.rules import with_tax


def checkout(prices):
    return with_tax(sum(prices))
