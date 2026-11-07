import tempfile
import unittest
import json
import nbtlib
from pathlib import Path
from litemapy import Region, BlockState, Schematic, Entity, TileEntity
from app import litematica as lm


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'test.litematic'
        negative = Region(-5, 3, 2, -2, -2, 2)
        negative[0, 0, 0] = BlockState('minecraft:stone')
        negative[-1, -1, 1] = BlockState('minecraft:oak_planks')
        other = Region(10, 10, 10, 1, 1, 1)
        other[0, 0, 0] = BlockState('minecraft:glass')
        Schematic(regions={'negative': negative, 'other': other}).save(str(self.path))

    def test_bounds_and_coordinates(self):
        preview = lm.preview(self.path)
        self.assertEqual(preview['origin'], [-6, 2, 2])
        self.assertEqual(preview['size'], [17, 9, 9])
        self.assertEqual(lm.parse_info(self.path)['size'], preview['size'])
        self.assertEqual({tuple(b[:3]) for b in preview['blocks']}, {(-5,3,2),(-6,2,3),(10,10,10)})

    def test_layer_and_region(self):
        preview = lm.preview(self.path, layer=2, region='negative')
        self.assertEqual(preview['total_blocks'], 1)
        self.assertEqual(preview['blocks'][0][:3], [-6,2,3])
        self.assertFalse(preview['sampled'])
        self.assertEqual(lm.preview(self.path, layer=5)['blocks'], [])
        with self.assertRaises(ValueError):
            lm.preview(self.path, region='missing')

    def test_preserves_distinct_block_states(self):
        region = Region(0, 0, 0, 2, 1, 1)
        region[0, 0, 0] = BlockState('minecraft:redstone_wall_torch', facing='east', lit='true')
        region[1, 0, 0] = BlockState('minecraft:redstone_wall_torch', facing='west', lit='false')
        Schematic(regions={'states': region}).save(str(self.path))
        preview = lm.preview(self.path)
        states = [preview['block_states'][block[3]] for block in preview['blocks']]
        self.assertEqual(states[0]['properties'], {'facing': 'east', 'lit': 'true'})
        self.assertEqual(states[1]['properties'], {'facing': 'west', 'lit': 'false'})
        self.assertNotEqual(preview['blocks'][0][3], preview['blocks'][1][3])

    def test_sample_limit_and_air(self):
        region = Region(0, 0, 0, 30, 30, 30)
        for pos in region.allblockpos():
            region[pos] = BlockState('minecraft:stone')
        region[0,0,0] = BlockState('minecraft:cave_air')
        Schematic(regions={'large':region}).save(str(self.path))
        result = lm.preview(self.path)
        self.assertTrue(result['sampled'])
        self.assertLessEqual(len(result['blocks']), 12000)
        self.assertEqual(result['total_blocks'], 26999)
        self.assertEqual(lm.parse_info(self.path)['total_blocks'], 26999)
        self.assertEqual(lm.preview(self.path, layer=1)['total_blocks'], 900)

    def test_entity_positions_appearance_and_block_entities(self):
        region = Region(-10, 5, 20, -3, 4, -3)
        stand = Entity('minecraft:armor_stand')
        stand.position = (-1.5, 1.0, -0.5)
        stand.rotation = (90.0, 0.0)
        stand.add_tag('Pose', nbtlib.Compound({'Head': nbtlib.List[nbtlib.Float]([30, 0, 0])}))
        stand.add_tag('equipment', nbtlib.Compound({'head': nbtlib.Compound({'id': nbtlib.String('minecraft:diamond_helmet')})}))
        stand.add_tag('Command', nbtlib.String('private command'))
        region.entities.append(stand)
        region[-1, 1, -1] = BlockState('minecraft:chest', facing='north', type='single')
        region.tile_entities.append(TileEntity(nbtlib.Compound({'id':nbtlib.String('minecraft:chest'), 'x':nbtlib.Int(-1), 'y':nbtlib.Int(1), 'z':nbtlib.Int(-1), 'Items':nbtlib.List[nbtlib.Compound]([])})))
        Schematic(regions={'entities':region}).save(str(self.path))
        result = lm.preview(self.path)
        self.assertEqual(result['entities'][0]['position'], [-11.5, 6, 19.5])
        self.assertEqual(result['entities'][0]['rotation'], [90, 0])
        self.assertEqual(result['entities'][0]['data']['Pose']['Head'], [30,0,0])
        self.assertEqual(result['entities'][0]['data']['equipment']['head']['id'], 'minecraft:diamond_helmet')
        self.assertNotIn('Command', result['entities'][0]['data'])
        self.assertEqual(result['block_entities'], [{'position':[-11,6,19], 'data':{}}])
        self.assertEqual(lm.preview(self.path, layer=5)['entities'], [])
        self.assertEqual(lm.preview(self.path, layer=6)['total_entities'], 1)

    def test_entity_only_preview_limit_and_sanitization(self):
        region = Region(0, 0, 0, 2, 2, 2)
        for _ in range(520):
            entity = Entity('minecraft:creeper')
            entity.position = (.5, 0, .5)
            region.entities.append(entity)
        Schematic(regions={'entities':region}).save(str(self.path))
        result = lm.preview(self.path)
        self.assertEqual(result['total_entities'], 520)
        self.assertEqual(len(result['entities']), 512)
        self.assertTrue(result['entities_sampled'])
        self.assertEqual(result['blocks'], [])
        data = lm.visual_nbt({'CustomName': 'x'*20000, 'Pose': {'Head':[float('nan'), 1, 2]}, 'unknown':'secret'})
        self.assertEqual(len(data['CustomName']), 8192)
        self.assertIsNone(data['Pose']['Head'][0])
        json.dumps(data, allow_nan=False)

    def test_mounted_passengers_are_not_lost(self):
        region = Region(4, 2, -3, 2, 3, 2)
        boat = Entity('minecraft:oak_boat')
        boat.position = (.5, 0, .5)
        boat.add_tag('Passengers', nbtlib.List[nbtlib.Compound]([
            nbtlib.Compound({'id':nbtlib.String('minecraft:pig'), 'Pos':nbtlib.List[nbtlib.Double]([.5, .5, .5])})
        ]))
        region.entities.append(boat)
        Schematic(regions={'riders':region}).save(str(self.path))
        result = lm.preview(self.path)
        self.assertEqual(result['total_entities'], 2)
        self.assertEqual(result['entities'][1]['id'], 'minecraft:pig')
        self.assertEqual(result['entities'][1]['position'], [4.5,2.5,-2.5])


if __name__ == '__main__':
    unittest.main()
