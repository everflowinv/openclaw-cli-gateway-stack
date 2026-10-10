"""Black-box regression for fragmented writes, rotation and SSE delivery."""
import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


class ViewerTests(unittest.TestCase):
    def test_sse_and_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'muse-cli-gateway.stdout.log'
            line = lambda value: '[MUSEGW] ' + json.dumps({'event': 'text', 'text': value}, ensure_ascii=False) + '\n'
            log.write_text(line('backlog') + line('中文😀')[:20])
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')), '--file', str(log), '--port', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            base = f'http://127.0.0.1:{port}'
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(base + '/sources', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.02)
                for n in ('garbage', '-1', '5001'):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(base + '/tail?n=' + n)
                    self.assertEqual(error.exception.code, 400)
                    error.exception.close()
                with urllib.request.urlopen(base + '/tail?n=0') as response:
                    self.assertEqual(json.load(response)['lines'], [])
                stream = urllib.request.urlopen(base + '/stream', timeout=5)
                def data():
                    while True:
                        record = stream.readline().decode('utf-8')
                        if record.startswith('data: [MUSEGW] '):
                            return json.loads(record.removeprefix('data: [MUSEGW] '))['text']
                self.assertEqual(data(), 'backlog')
                # Fragment inside the UTF-8 encoding of an emoji.
                remaining = line('中文😀')[20:].encode()
                split = remaining.index('😀'.encode()) + 2
                with log.open('ab') as output:
                    output.write(remaining[:split]); output.flush()
                    time.sleep(.2)
                    output.write(remaining[split:]); output.flush()
                self.assertEqual(data(), '中文😀')
                with log.open('a') as output:
                    for i in range(300):
                        output.write(line(f'burst-{i}'))
                self.assertEqual([data() for _ in range(300)], [f'burst-{i}' for i in range(300)])
                log.rename(root / 'rotated.log')
                log.write_text(line('after-rotation'))
                self.assertEqual(data(), 'after-rotation')
                log.write_text(line('truncated'))
                self.assertEqual(data(), 'truncated')
                stream.close()
            finally:
                process.terminate()
                try:
                    _, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); _, stderr = process.communicate()
                self.assertEqual(stderr, b'')


if __name__ == '__main__':
    unittest.main()
