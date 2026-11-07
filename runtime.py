"""Manage the independent MCDR host, without running the website."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent / 'backend'))

from app.runtime_client import HostLock, RuntimeClient, RuntimeUnavailable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'run', 'status', 'stop'])
    parser.add_argument('--stop-instances', action='store_true', help='停服并保存世界后退出托管服务')
    args = parser.parse_args()
    client = RuntimeClient()
    try:
        if args.action == 'run':
            from app.runtime_host import main as run
            run()
        elif args.action == 'start':
            print(json.dumps(asyncio.run(client.ensure_started()), ensure_ascii=False, indent=2))
        elif args.action == 'status':
            print(json.dumps(client.request('snapshot'), ensure_ascii=False, indent=2))
        else:
            client.request('shutdown', stop_instances=args.stop_instances)
            # Wait for the host's OS lock, not merely for its listening socket.
            deadline = time.monotonic() + 100
            while time.monotonic() < deadline:
                try:
                    lock = HostLock(client.root)
                    lock.close()
                    print('MCDR 托管服务已停止')
                    return
                except RuntimeUnavailable:
                    time.sleep(.2)
            raise RuntimeError('托管服务仍在退出，请检查 runtime/host.log')
    except RuntimeError as exc:
        parser.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
