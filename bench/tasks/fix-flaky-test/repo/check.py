import subprocess
import sys

source = open('test_ids.py').read()
assert 'new_id' in source and '8' in source, 'the test no longer checks new_id'
assert 'rng=random' in open('ids.py').read(), 'ids.py was changed'
for _ in range(25):
    run = subprocess.run([sys.executable, '-m', 'unittest', '-q', 'test_ids'], capture_output=True)
    assert run.returncode == 0, 'test still fails sometimes'
