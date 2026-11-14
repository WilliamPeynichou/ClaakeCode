from bank.money import fmt
from bank.store import rows


def monthly_report():
    lines = ['%s: %s' % (label, fmt(cents)) for label, cents in rows()]
    lines.append('total: %s' % fmt(sum(cents for _, cents in rows())))
    return lines
