#!/usr/bin/env python3
"""Live log viewer HTTP server.

Usage: server.py --file <logfile> [--file <logfile> ...] [--port 8765]

Each --file becomes a source rendered as its own tab in index.html. Sources
are served per-id: /stream?source=<id>, /tail?source=<id>, /sources lists them.
A single --file keeps working (one tab).
"""
import argparse
import json
import os
import time
import threading
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

BASE_DIR = Path(__file__).parent
DEFAULT_PORT = 8765
HISTORY_MAX = 5000          # ring buffer per source for reconnect replay
INITIAL_BACKLOG = 500       # lines sent to a fresh client
PING_INTERVAL = 10          # seconds between SSE ping events

parser = argparse.ArgumentParser()
parser.add_argument('--file', required=True, action='append', dest='files',
                    help='Log file to watch (repeatable, one tab per file)')
parser.add_argument('--port', type=int, default=DEFAULT_PORT)
args = parser.parse_args()

PORT = args.port


class Source:
    """One watched log file: ring-buffer history + SSE subscribers."""

    def __init__(self, path: str):
        self.path = Path(path)
        stem = self.path.name
        for suffix in ('.stdout.log', '.stderr.log', '.log'):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        self.id = stem
        base = stem.split('-cli-gateway')[0]
        known = {
            'claude': 'Claude CLI',
            'antigravity': 'Antigravity CLI',
            'agy': 'Antigravity CLI',
            'muse': 'Muse Code',
        }
        self.label = known.get(base, stem)
        self.history = deque(maxlen=HISTORY_MAX)
        self.seq = 0
        self.subscribers = []  # list of (queue:list[(seq,line)], done:Event)


SOURCES = [Source(p) for p in args.files]
SOURCES_BY_ID = {s.id: s for s in SOURCES}
if len(SOURCES_BY_ID) != len(SOURCES):
    raise SystemExit('duplicate source ids (two files with the same stem?)')

state_lock = threading.Lock()


def broadcast(source: Source, line: str):
    with state_lock:
        source.seq += 1
        item = (source.seq, line)
        source.history.append(item)
        dead = []
        for q, done in source.subscribers:
            if done.is_set():
                dead.append((q, done))
            else:
                q.append(item)
        for d in dead:
            source.subscribers.remove(d)


def tail_file(path: Path, n: int = 500) -> list:
    """Return last n lines of file."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            chunk = min(size, 1024 * 1024)
            f.seek(max(0, size - chunk))
            data = f.read().decode('utf-8', errors='replace')
        lines = data.splitlines()
        return lines[-n:]
    except (FileNotFoundError, OSError):
        return []


def close_quiet(f):
    try:
        f.close()
    except Exception:
        pass
    return None


def watch_file(source: Source):
    """tail -f loop. Must never leave a closed file in `f`; on any I/O
    trouble set f=None and reopen on the next iteration. On reopen: a new
    inode is read from the beginning (rotation must not drop lines already
    written to the new file), the same inode resumes at the previous offset
    (a transient stat error must not replay the whole file)."""
    log_file = source.path
    f = None
    first_open = True
    last_ino = None
    last_pos = 0
    while True:
        if f is None:
            try:
                f = open(log_file, 'r', encoding='utf-8', errors='replace')
                st = os.fstat(f.fileno())
                if first_open:
                    f.seek(0, 2)
                elif st.st_ino == last_ino:
                    f.seek(min(last_pos, st.st_size))
                first_open = False
                last_ino = st.st_ino
            except OSError:
                f = None
                time.sleep(1)
                continue
        try:
            line = f.readline()
            last_pos = f.tell()
        except (OSError, ValueError):
            f = close_quiet(f)
            time.sleep(0.5)
            continue
        if line:
            broadcast(source, line.rstrip('\n'))
            continue
        # idle: detect rotation (inode changed) or in-place truncation
        try:
            st = os.stat(log_file)
            if st.st_ino != os.fstat(f.fileno()).st_ino:
                f = close_quiet(f)
                continue
            if st.st_size < f.tell():
                f.seek(0)
                last_pos = 0
                continue
        except (OSError, ValueError):
            f = close_quiet(f)
            continue
        time.sleep(0.1)


def watcher_supervisor(source: Source):
    """The watcher thread must survive anything; a dead watcher means every
    client silently stops receiving data while the SSE socket stays open."""
    while True:
        try:
            watch_file(source)
        except Exception:
            traceback.print_exc()
            time.sleep(1)


# Prime history so first-connect clients get a backlog without /tail.
for _source in SOURCES:
    for _line in tail_file(_source.path, n=1000):
        broadcast(_source, _line)

for _source in SOURCES:
    threading.Thread(target=watcher_supervisor, args=(_source,), daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass  # silence access log

    def do_GET(self):
        # 这个服务把 gateway 日志（含 prompt/工具调用内容）整段吐出来，
        # 绝不能走公网。tailscale serve 会剥掉客户端自带的 Tailscale-* 头，
        # 所以这个头出现 = 真的是 funnel（公网）请求 → 直接拒。
        if self.headers.get('Tailscale-Funnel-Request') is not None:
            self.send_error(403, 'Funnel (public) requests are not allowed')
            return

        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == '/robots.txt':
            body = b'User-agent: *\nDisallow: /\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Robots-Tag', 'noindex, nofollow, noarchive')
            self.end_headers()
            self.wfile.write(body)
            return

        source = SOURCES_BY_ID.get(qs.get('source', [SOURCES[0].id])[0], SOURCES[0])

        if path == '/' or path == '/index.html':
            self.serve_index()
        elif path == '/sources':
            self.serve_sources()
        elif path == '/tail':
            n = int(qs.get('n', ['500'])[0])
            self.serve_tail(source, n)
        elif path == '/stream':
            self.serve_stream(source, parsed)
        else:
            self.send_error(404)

    def serve_index(self):
        data = (BASE_DIR / 'index.html').read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_sources(self):
        body = json.dumps([
            {'id': s.id, 'label': s.label, 'file': str(s.path)} for s in SOURCES
        ]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_tail(self, source: Source, n: int):
        lines = tail_file(source.path, n)
        body = json.dumps({'file': str(source.path), 'lines': lines}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_stream(self, source: Source, parsed):
        # Resume point: ?since=<seq> (manual reconnect) or Last-Event-ID
        # header (EventSource auto-reconnect). None = fresh client.
        since = None
        qs = parse_qs(parsed.query)
        if 'since' in qs:
            try:
                since = int(qs['since'][0])
            except ValueError:
                pass
        if since is None:
            hdr = self.headers.get('Last-Event-ID')
            if hdr and hdr.isdigit():
                since = int(hdr)

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        queue = []
        done = threading.Event()
        with state_lock:
            # A server restart resets seq counting; a client resuming with a
            # stale Last-Event-ID higher than the fresh seq would otherwise
            # receive nothing forever while looking perfectly "live". Treat
            # that as a fresh client and replay the backlog.
            if since is None or since > source.seq:
                backlog = list(source.history)[-INITIAL_BACKLOG:]
            else:
                backlog = [it for it in source.history if it[0] > since]
            source.subscribers.append((queue, done))

        try:
            meta = json.dumps({'file': str(source.path), 'source': source.id})
            self.wfile.write(f"event: meta\ndata: {meta}\n\n".encode('utf-8'))
            for s, line in backlog:
                self.wfile.write(f"id: {s}\ndata: {line}\n\n".encode('utf-8'))
            self.wfile.flush()

            last_ping = time.time()
            while True:
                if queue:
                    batch = queue.copy()
                    queue.clear()
                    for s, line in batch:
                        self.wfile.write(f"id: {s}\ndata: {line}\n\n".encode('utf-8'))
                    self.wfile.flush()
                    last_ping = time.time()
                else:
                    if time.time() - last_ping > PING_INTERVAL:
                        self.wfile.write(b"event: ping\ndata: 1\n\n")
                        self.wfile.flush()
                        last_ping = time.time()
                    time.sleep(0.1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            done.set()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    names = ', '.join(f'{s.label} → {s.path}' for s in SOURCES)
    print(f"Log viewer running at http://localhost:{PORT} | {names}")
    server.serve_forever()
