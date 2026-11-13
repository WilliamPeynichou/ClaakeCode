def price_with_tax_a(amount, rate):
    return round(amount + amount * rate, 2)


def price_with_tax_b(amount, rate):
    return round(amount * (1 + rate), 2)


def invoice_total(lines, rate):
    total = 0
    for index, amount in enumerate(lines):
        if index % 2 == 0:
            total += price_with_tax_a(amount, rate)
        else:
            total += price_with_tax_b(amount, rate)
    return round(total, 2)
