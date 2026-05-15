#!/usr/bin/env python3
"""Downloads a video URL with Chrome-impersonated TLS via curl_cffi."""
import sys, json, os
from curl_cffi import requests as cffi_requests

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 download.py <info.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        info = json.load(f)

    streams = info['streams']   # list of {url, path, label}
    cookie_str = info['cookies']
    cookies = {}
    for part in cookie_str.split('; '):
        if '=' in part:
            k, v = part.split('=', 1)
            cookies[k.strip()] = v.strip()

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://drive.google.com/',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity;q=1, *;q=0',
    }

    for stream in streams:
        url = stream['url'].split('&range=')[0]
        out_path = stream['path']
        label = stream['label']

        print(f"\n  Downloading {label}…", flush=True)

        with cffi_requests.Session(impersonate='chrome120') as session:
            # HEAD to get total size
            try:
                head = session.head(url, headers=headers, cookies=cookies, allow_redirects=True, timeout=30)
                total = int(head.headers.get('content-length', 0))
            except Exception:
                total = 0

            CHUNK = 8 * 1024 * 1024
            downloaded = 0
            offset = 0

            if os.path.exists(out_path):
                os.remove(out_path)

            while True:
                end = min(offset + CHUNK - 1, total - 1) if total > 0 else offset + CHUNK - 1
                range_headers = {**headers, 'Range': f'bytes={offset}-{end}'}
                try:
                    r = session.get(url, headers=range_headers, cookies=cookies,
                                    allow_redirects=True, timeout=60)
                except Exception as e:
                    print(f"\n  Request error: {e}", file=sys.stderr)
                    sys.exit(1)

                if r.status_code not in (200, 206):
                    print(f"\n  HTTP {r.status_code} for {label}", file=sys.stderr)
                    print(f"  Response: {r.text[:200]}", file=sys.stderr)
                    sys.exit(1)

                data = r.content
                if not data:
                    break

                with open(out_path, 'ab') as f:
                    f.write(data)

                downloaded += len(data)
                offset += len(data)

                if total > 0:
                    pct = round(downloaded / total * 100)
                    mb = downloaded / 1024 / 1024
                    print(f"\r  {label}: {pct}%  ({mb:.1f} MB)   ", end='', flush=True)
                else:
                    mb = downloaded / 1024 / 1024
                    print(f"\r  {label}: {mb:.1f} MB   ", end='', flush=True)

                if total > 0 and downloaded >= total:
                    break
                if total == 0 and len(data) < CHUNK:
                    break

        print(flush=True)

    print("\n  Python download complete.", flush=True)

if __name__ == '__main__':
    main()
