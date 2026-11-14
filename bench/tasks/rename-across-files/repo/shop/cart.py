from shop.totals import calc


def cart_total(cart):
    return calc(item['price'] for item in cart)
