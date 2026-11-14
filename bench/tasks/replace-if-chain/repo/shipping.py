def shipping_cost(country):
    if country == 'FR':
        return 5
    elif country == 'BE':
        return 7
    elif country == 'DE':
        return 8
    elif country == 'US':
        return 15
    else:
        return 20
