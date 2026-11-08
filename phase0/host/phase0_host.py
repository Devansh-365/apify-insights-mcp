#!/opt/homebrew/bin/python3
"""Phase 0 native messaging host. Chrome starts it once per message; it answers and exits.

Writes token-free reports to ~/.apify-insights/phase0/report.jsonl. As a safety net it refuses
to write anything that looks like a credential (JWT-shaped or very long strings).
"""
import json
import os
import re
import struct
import sys
import time

OUT_DIR = os.path.expanduser('~/.apify-insights/phase0')
JWT_LIKE = re.compile(r'^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$')


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack('<I', raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


def write_message(message):
    data = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def looks_secret(value):
    if isinstance(value, str):
        return len(value) > 120 or bool(JWT_LIKE.match(value))
    if isinstance(value, dict):
        return any(looks_secret(v) for v in value.values())
    if isinstance(value, list):
        return any(looks_secret(v) for v in value)
    return False


def main():
    message = read_message()
    if message is None:
        return 1
    op = message.get('op')
    if op == 'ping':
        write_message({'ok': True, 'pid': os.getpid(), 'at': time.time()})
        return 0
    if op == 'report':
        report = message.get('report')
        if looks_secret(report):
            write_message({'ok': False, 'error': 'refused: report contains a credential-like value'})
            return 2
        os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
        path = os.path.join(OUT_DIR, 'report.jsonl')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a') as handle:
            handle.write(json.dumps(report) + '\n')
        write_message({'ok': True})
        return 0
    write_message({'ok': False, 'error': f'unknown op {op!r}'})
    return 3


if __name__ == '__main__':
    sys.exit(main())
