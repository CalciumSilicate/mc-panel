import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import onebot
from app.database import Base
from app.models import Server, ServerGroup


class GroupBindingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine)
        with self.sessions() as db:
            db.add_all([
                ServerGroup(id=1, name='bound', qq_group_ids='[111]'),
                ServerGroup(id=2, name='empty', qq_group_ids='["222"]'),
                Server(id=1, name='survival', dir_name='survival',
                       server_type='fabric', group_id=1),
            ])
            db.commit()
        self.enterContext(patch.object(onebot, 'SessionLocal', self.sessions))
        self.send = self.enterContext(patch.object(onebot.client, 'send_group'))
        self.action = self.enterContext(patch.object(onebot.client, 'call_action', new_callable=AsyncMock))
        self.cache = self.enterContext(patch.object(onebot, '_cache_image', new_callable=AsyncMock))
        self.action.return_value = {}
        self.cache.return_value = '/api/chat/img/test.png'
        self.publish = self.enterContext(patch('app.chat.publish'))

    def tearDown(self):
        self.engine.dispose()

    async def message(self, group, message):
        await onebot._process_group_message({
            'group_id': group, 'user_id': 42, 'message_id': 7,
            'sender': {'nickname': 'tester'}, 'message': message,
        })

    async def test_unbound_group_never_dispatches_commands(self):
        with patch.object(onebot, '_maybe_handle_command', new_callable=AsyncMock) as dispatch:
            for command in ('#', '##', '&', '%', '% survival', '^', '^ Steve'):
                await self.message(999, command)
        dispatch.assert_not_awaited()
        self.send.assert_not_called()

    async def test_unbound_media_and_replies_have_no_side_effects(self):
        await self.message(999, [
            {'type': 'image', 'data': {'url': 'https://example.invalid/image.png'}},
            {'type': 'reply', 'data': {'id': '123'}},
        ])
        self.cache.assert_not_awaited()
        self.action.assert_not_awaited()
        self.publish.assert_not_called()
        self.send.assert_not_called()

    async def test_bound_player_command_uses_only_its_servers(self):
        with patch.object(onebot, '_cmd_show_players', new_callable=AsyncMock) as players:
            await self.message(111, '#')
        players.assert_awaited_once_with(111, [1])

    async def test_bound_group_without_servers_still_handles_commands(self):
        with patch.object(onebot, '_cmd_show_players', new_callable=AsyncMock) as players:
            await self.message(222, '#')
        players.assert_awaited_once_with(222, [])

    async def test_removed_binding_takes_effect_on_next_message(self):
        with self.sessions() as db:
            db.get(ServerGroup, 1).qq_group_ids = '[]'
            db.commit()
        with patch.object(onebot, '_maybe_handle_command', new_callable=AsyncMock) as dispatch:
            await self.message(111, '#')
        dispatch.assert_not_awaited()

    async def test_bound_chat_is_published_to_matching_group(self):
        with patch('app.mcdr.manager.is_running', return_value=False):
            await self.message(111, 'hello')
        self.publish.assert_called_once()
        self.assertEqual(self.publish.call_args.args[0], 1)
        self.assertEqual(self.publish.call_args.args[1]['text'], 'hello')


if __name__ == '__main__':
    unittest.main()
