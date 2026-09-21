import base64
import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch

from PIL import Image

from app import onebot
from app.qqimg.player_list_image import draw_text, load_font


class MixedFontTests(unittest.TestCase):
    def test_bundled_families_and_weights(self):
        regular = load_font(28)
        bold = load_font(28, True)
        self.assertEqual([f.getname()[0] for f in regular], ['Noto Sans SC', 'Lexend'])
        for index, text in enumerate(['中文', 'Steve_123']):
            self.assertNotEqual(bytes(regular[index].getmask(text)), bytes(bold[index].getmask(text)))

    def test_runs_share_baseline_and_align_as_one_line(self):
        cjk, latin = MagicMock(), MagicMock()
        cjk.getlength.return_value = 30
        cjk.getbbox.return_value = (0, -20, 30, 2)
        latin.getlength.return_value = 17
        latin.getbbox.return_value = (0, -15, 17, 4)
        draw = MagicMock()
        draw_text(draw, (100, 50), '生存A2服', fill='black', font=(cjk, latin), anchor='rm')
        calls = draw.text.call_args_list
        self.assertEqual([c.args for c in calls], [((23, 58), '生存'), ((53, 58), 'A2'), ((70, 58), '服')])
        self.assertEqual([c.kwargs['font'] for c in calls], [cjk, latin, cjk])
        self.assertTrue(all(c.kwargs['anchor'] == 'ls' for c in calls))


class PlayerImageTests(unittest.IsolatedAsyncioTestCase):
    async def test_player_command_sends_valid_base64_png(self):
        db = MagicMock()
        db.scalars.return_value.all.return_value = []
        image = Image.new('RGBA', (3, 2), (17, 89, 203, 255))
        with (
            patch.object(onebot, 'SessionLocal', return_value=db),
            patch('app.qqimg.player_list_image.render_player_list_image', return_value=image) as render,
            patch.object(onebot.client, 'send_group') as send,
        ):
            self.assertTrue(await onebot._maybe_handle_command(12345, [], '#'))
        render.assert_called_once_with('服务器组', [])
        db.close.assert_called_once()
        send.assert_called_once()
        group, message = send.call_args.args
        self.assertEqual(group, 12345)
        prefix = '[CQ:image,file=base64://'
        self.assertTrue(message.startswith(prefix), message)
        self.assertTrue(message.endswith(']'))
        raw = base64.b64decode(message[len(prefix):-1], validate=True)
        with Image.open(BytesIO(raw)) as result:
            self.assertEqual(result.format, 'PNG')
            self.assertEqual(result.size, (3, 2))
            self.assertEqual(result.getpixel((1, 1)), (17, 89, 203))
