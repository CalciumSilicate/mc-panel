import asyncio
import unittest
from unittest.mock import patch

from app import bridge


class PresenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bridge._ONLINE.clear()
        bridge._JOIN_TS.clear()
        bridge._BOTS.clear()
        bridge._PENDING_LEAVES.clear()
        self.broadcast = self.enterContext(patch.object(bridge, "_broadcast"))
        self.enterContext(patch.object(bridge, "TRANSFER_GRACE_SECONDS", 0.02))
        self.enterContext(patch.object(bridge, "_presence_scope", side_effect=lambda sid:
                                      (("proxy", 1), [1, 2]) if sid in (1, 2) else (("server", sid), [sid])))
        self.enterContext(patch.object(bridge, "_group_online_count", side_effect=lambda sid: len(
            {n for names in bridge._ONLINE.values() for n in names} |
            {p["name"] for p in bridge._PENDING_LEAVES.values()}
        )))

    def tearDown(self):
        for pending in bridge._PENDING_LEAVES.values():
            pending["timer"].cancel()
        bridge._PENDING_LEAVES.clear()

    def join(self, sid, name="Steve", address="/127.0.0.1"):
        bridge.handle_line(sid, f"[Server thread/INFO]: {name}[{address}] logged in with entity id 1")

    def leave(self, sid, name="Steve"):
        bridge.handle_line(sid, f"[Server thread/INFO]: {name} left the game")

    async def test_transfer_and_real_exit(self):
        self.join(1)
        joined = bridge.online_since(1, "Steve")
        self.leave(1)
        self.join(2)
        await asyncio.sleep(0.04)
        self.assertEqual(self.broadcast.call_count, 1)
        self.assertEqual(bridge.online_since(2, "Steve"), joined)
        self.leave(2)
        self.assertEqual(self.broadcast.call_count, 1)
        await asyncio.sleep(0.04)
        self.assertEqual(self.broadcast.call_count, 2)
        self.assertEqual(self.broadcast.call_args.args[2], "-Steve (1→0)")

    async def test_join_before_leave_and_duplicate_events(self):
        self.join(1)
        self.join(2)
        self.leave(1)
        self.leave(1)
        self.join(2)
        await asyncio.sleep(0.04)
        self.assertEqual(self.broadcast.call_count, 1)

    async def test_first_join_other_proxy_timeout_and_bots(self):
        self.leave(1)
        self.join(1, "Bot", "local")
        self.leave(1, "Bot")
        self.assertEqual(self.broadcast.call_count, 0)
        self.join(1)
        self.leave(1)
        self.join(3)
        self.assertEqual(self.broadcast.call_count, 2)
        await asyncio.sleep(0.04)
        self.assertEqual(self.broadcast.call_count, 3)
        self.leave(3)
        await asyncio.sleep(0.04)
        self.join(3)
        self.assertEqual(self.broadcast.call_count, 5)
