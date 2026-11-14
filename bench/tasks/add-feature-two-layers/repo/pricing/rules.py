def with_tax(price, rate=0.2):
    return round(price * (1 + rate), 2)
