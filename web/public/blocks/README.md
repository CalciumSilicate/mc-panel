Minecraft Java 1.21.1 block textures and Chinese names. Game assets belong to Mojang/Microsoft.

Sources:
- https://github.com/PrismarineJS/minecraft-assets/tree/master/data/1.21.1
- https://github.com/InventivetalentDev/minecraft-assets/tree/1.21.1/assets/minecraft/lang

Atlas: 16 px cells, 32 columns; animated textures use the first frame. blocks.json stores atlas indices.


## Litematica 3D preview (Java 26.3)

The preview separately uses the official Java **26.3** client, not the legacy material-list atlas above.
Client source: https://piston-data.mojang.com/v1/objects/e877b6a07acd633fb3bb475002175cec036e7b87/client.jar
SHA-1: `e877b6a07acd633fb3bb475002175cec036e7b87`.

Rebuild from the repository root (Pillow and Java 25+ required):

```powershell
.venv/Scripts/python.exe scripts/extract-preview-assets.py --java <path-to-java.exe>
node scripts/audit-preview.mjs http://localhost:5278
npm --prefix web run test:baseline -- litematica
```

`ExportModels.java` calls the client's model-layer factory without opening a game or graphics context. Minecraft's data generator supplies the full registry and block-state combinations. Client and library downloads are checksum verified and cached under `data/download_cache`; binaries are not committed. The ECJ compiler is used so a JRE is sufficient.

Generated assets:

- `models/definitions.json`: block/item definitions, default states, equipment/variant metadata, item extrusion contours and texture rectangles.
- `models/entities.json`: the 361 vanilla model layers plus eight sitting/sleeping snapshots produced by the client's own pose methods; includes pivots, hierarchical transforms, normals and face UVs.
- `models/atlas.png`: native-resolution block, item, entity, painting and armor-trim textures; animated textures use their first declared frame.
- `models/coverage-input.json`: 1,286 registered block types / 35,723 states and 161 entity types. Includes intentionally invisible blocks/entities. Moving pistons need their saved block state.
- `models/names.json`: official Chinese block/entity names.

The browser coverage check verifies finite geometry and texture resolution for every block state, default entity and all 1,658 item definitions, plus data-driven animal variants and representative equipment/poses. It does **not** assert pixel parity with Minecraft's renderer.

This is a static schematic preview. It supports special block models (chests, shulker boxes, skulls, banners, decorated pots, conduits, copper golem statues, fluids), saved entities, armor-stand poses, equipment and trims, item frames, paintings and display entities. Embedded official player-skin texture hashes load through an authenticated, host-restricted proxy; a profile containing only a name/UUID has no embedded texture and uses the default skin. Sign/display text uses the browser font. Map pixels, beacon structure/lighting and other world data absent from `.litematic` cannot be reconstructed. Animated effects, game simulation, resource packs and mod-specific renderers are outside this static asset coverage. Large previews sample blocks and cap entities; the UI reports the limits.

All Minecraft game assets belong to Mojang/Microsoft.
