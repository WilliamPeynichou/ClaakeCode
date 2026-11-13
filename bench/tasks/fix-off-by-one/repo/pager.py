def paginate(items, page, size):
    """Return the items of a 1-based page."""
    start = page * size
    return items[start:start + size]
