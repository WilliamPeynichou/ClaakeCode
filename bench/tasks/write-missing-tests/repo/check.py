import re
import subprocess
import sys

source = open('test_clamp.py').read()
assert len(re.findall(r'def test_', source)) >= 3, 'need at least 3 tests'
assert 'return max(low, min(high, value))' in open('clamp.py').read(), 'clamp.py was changed'
# The tests must fail on a broken implementation.
original = open('clamp.py').read()
try:
    open('clamp.py', 'w').write('def clamp(value, low, high):\n    return value\n')
    broken = subprocess.run([sys.executable, '-m', 'unittest', '-q', 'test_clamp'], capture_output=True)
finally:
    open('clamp.py', 'w').write(original)
assert broken.returncode != 0, 'tests pass on a broken clamp'
good = subprocess.run([sys.executable, '-m', 'unittest', '-q', 'test_clamp'], capture_output=True)
assert good.returncode == 0, 'tests fail on the real clamp'
