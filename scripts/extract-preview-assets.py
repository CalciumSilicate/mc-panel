"""Reproduce the preview assets from the checksum-verified Java 26.3 client.

Requires Pillow and Java 25+ (JAVA or --java). Never launches the game/window.
The game data generator supplies the authoritative block/entity registries.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import urllib.request
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/download_cache'
OUT = ROOT / 'web/public/blocks/models'
VERSION = '26.3'
MANIFEST = 'https://piston-meta.mojang.com/v1/packages/80608ff6753705b6a82e2cb86a5937d4d233abd4/26.3.json'


def download(url, path, sha1=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or (sha1 and hashlib.sha1(path.read_bytes()).hexdigest() != sha1):
        with urllib.request.urlopen(url, timeout=120) as response:
            content = response.read()
        if sha1 and hashlib.sha1(content).hexdigest() != sha1:
            raise ValueError(f'Checksum mismatch: {url}')
        path.write_bytes(content)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--java', default=os.environ.get('JAVA', 'java'))
    args = parser.parse_args()
    manifest = json.loads(download(MANIFEST, CACHE / f'preview-{VERSION}.json').read_text())
    client = manifest['downloads']['client']
    jar_path = download(client['url'], CACHE / f'models-client-{VERSION}.jar', client['sha1'])
    libs = CACHE / 'model-libs'
    artifacts = [lib['downloads']['artifact'] for lib in manifest['libraries'] if 'artifact' in lib.get('downloads', {})]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda a: download(a['url'], libs / Path(a['path']).name, a['sha1']), artifacts))
    ecj_url = 'https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.43.0/ecj-3.43.0.jar'
    with urllib.request.urlopen(ecj_url + '.sha1', timeout=30) as response:
        ecj_sha = response.read().decode().strip()
    ecj = download(ecj_url, libs / 'ecj.jar', ecj_sha)
    work = CACHE / f'preview-export-{VERSION}'
    work.mkdir(exist_ok=True)
    gson = next(libs.glob('gson-*.jar'))
    subprocess.run([args.java, '-jar', str(ecj), '-17', '-cp', str(gson), '-d', str(work), str(ROOT / 'scripts/ExportModels.java')], check=True)
    cp = os.pathsep.join(map(str, [work, libs / '*', jar_path]))
    subprocess.run([args.java, '-cp', cp, 'ExportModels', str(work / 'layers.json')], check=True)
    subprocess.run([args.java, '-cp', cp, 'net.minecraft.data.Main', '--reports', '--output', str(work / 'data')], check=True)
    layers = json.loads((work / 'layers.json').read_text())
    # Round harmless float noise to reduce download and parse costs.
    def compact(value):
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError('Non-finite model coordinate')
            return round(value, 6)
        if isinstance(value, list): return [compact(v) for v in value]
        if isinstance(value, dict): return {k: compact(v) for k, v in value.items()}
        return value

    with zipfile.ZipFile(jar_path) as jar:
        def json_files(prefix):
            return {n[len(prefix):-5]: json.loads(jar.read(n)) for n in sorted(jar.namelist()) if n.startswith(prefix) and n.endswith('.json')}
        models = json_files('assets/minecraft/models/')
        states = json_files('assets/minecraft/blockstates/')
        items = json_files('assets/minecraft/items/')
        paintings = json_files('data/minecraft/painting_variant/')
        equipment = json_files('assets/minecraft/equipment/')
        variants = {kind: json_files(f'data/minecraft/{kind}_variant/') for kind in ['cat','cow','pig','chicken','frog','wolf','zombie_nautilus']}
        images = []
        for name in sorted(jar.namelist()):
            prefix = 'assets/minecraft/textures/'
            if not name.startswith(prefix) or not name.endswith('.png'): continue
            key = name[len(prefix):-4]
            if not key.startswith(('block/', 'item/', 'entity/', 'painting/', 'environment/', 'trims/', 'palettes/')): continue
            image = Image.open(io.BytesIO(jar.read(name))).convert('RGBA')
            if name + '.mcmeta' in jar.namelist():
                animation = json.loads(jar.read(name + '.mcmeta')).get('animation', {})
                w = animation.get('width', image.width)
                h = animation.get('height', min(image.width, image.height))
                frame = animation.get('frames', [0])[0]
                if isinstance(frame, dict): frame = frame['index']
                x, y = (frame % (image.width // w)) * w, (frame // (image.width // w)) * h
                image = image.crop((x, y, x+w, y+h))
            images.append((key, image))
        image_map = dict(images)
        palette_base = image_map['palettes/trim_base']
        base_colors = list(palette_base.getdata())
        for key, source in list(images):
            if not key.startswith('trims/'): continue
            for palette_key, palette in list(image_map.items()):
                if not palette_key.startswith('palettes/trim/'): continue
                lookup = {a[:3]: b[:3] for a,b in zip(base_colors, palette.getdata())}
                target = source.copy()
                target.putdata([(*lookup.get(pixel[:3],pixel[:3]),pixel[3]) for pixel in source.getdata()])
                images.append((key+'_'+palette_key.rsplit('/',1)[1],target))
        # Boundary spans for vanilla generated items give icons their true thin
        # extrusion instead of drawing an opaque square or a flat billboard.
        contours = {}
        for key, source in images:
            if not key.startswith('item/'): continue
            alpha = source.getchannel('A')
            w,h = source.size
            def opaque(x,y): return 0 <= x < w and 0 <= y < h and alpha.getpixel((x,y)) > 0
            spans = []
            for direction, dx, dy in [('up',0,-1),('down',0,1),('west',-1,0),('east',1,0)]:
                horizontal = dy != 0
                for row in range(h if horizontal else w):
                    start = None
                    length = w if horizontal else h
                    for col in range(length+1):
                        x,y = (col,row) if horizontal else (row,col)
                        exposed = col < length and opaque(x,y) and not opaque(x+dx,y+dy)
                        if exposed and start is None: start = col
                        if not exposed and start is not None:
                            spans.append([direction,start,col,row,w,h])
                            start = None
            contours[key] = spans
        # Shelf pack at native resolution. UVs reference rectangles, never adjacent tiles.
        width = 2048
        rects, textures, x, y, row_h = [], {}, 0, 0, 0
        for key, image in images:
            if x + image.width > width: x, y, row_h = 0, y+row_h, 0
            textures[key] = len(rects)
            rects.append([x, y, image.width, image.height])
            x += image.width
            row_h = max(row_h, image.height)
        atlas = Image.new('RGBA', (width, y+row_h))
        for (_, image), rect in zip(images, rects): atlas.paste(image, tuple(rect[:2]))
        OUT.mkdir(parents=True, exist_ok=True)
        atlas.save(OUT / 'atlas.png', optimize=True)
        blocks = json.loads((work / 'data/reports/blocks.json').read_text())
        registry = json.loads((work / 'data/reports/registries.json').read_text())
        defaults = {k.removeprefix('minecraft:'): next((s.get('properties', {}) for s in b['states'] if s.get('default')), {}) for k,b in blocks.items()}
        assets = dict(version=VERSION, models=models, states=states, textures=textures, textureRects=rects, defaults=defaults, items=items, itemContours=contours, paintings=paintings, equipment=equipment, variants=variants)
        (OUT / 'definitions.json').write_text(json.dumps(assets, separators=(',', ':')), encoding='utf-8')
        (OUT / 'entities.json').write_text(json.dumps(compact(layers), separators=(',', ':')), encoding='utf-8')
        # Full state combinations used by the browser coverage test.
        (OUT / 'coverage-input.json').write_text(json.dumps(dict(version=VERSION, blocks=blocks, entities=list(registry['minecraft:entity_type']['entries'])), separators=(',', ':')), encoding='utf-8')
        index = manifest['assetIndex']
        asset_index = json.loads(download(index['url'], CACHE / f'asset-index-{VERSION}.json', index['sha1']).read_text())
        lang_hash = asset_index['objects']['minecraft/lang/zh_cn.json']['hash']
        translations = json.loads(download(f'https://resources.download.minecraft.net/{lang_hash[:2]}/{lang_hash}', CACHE / f'zh-cn-{VERSION}.json', lang_hash).read_text(encoding='utf-8'))
        (OUT / 'names.json').write_text(json.dumps({k:v for k,v in translations.items() if k.startswith(('block.minecraft.', 'entity.minecraft.'))}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{VERSION}: {len(models)} models, {len(states)} block types, {len(layers)} entity layers, {len(textures)} textures; atlas {atlas.size}')


if __name__ == '__main__':
    main()
