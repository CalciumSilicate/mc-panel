"""Prepare Fabric's bootstrap cache without starting Java or the game."""
from __future__ import annotations

import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from . import jar_cache, versions


def _manifest(attributes: dict[str, str]) -> bytes:
    result = bytearray()
    for key, value in attributes.items():
        if '\r' in value or '\n' in value:
            raise ValueError('Invalid manifest attribute')
        line = f'{key}: {value}'.encode('utf-8')
        result += line[:72] + b'\r\n'
        line = line[72:]
        while line:
            result += b' ' + line[:71] + b'\r\n'
            line = line[71:]
    return bytes(result) + b'\r\n'


async def install(server_dir: Path, mc: str, loader: str, progress=None) -> None:
    profile = await versions._cached_json(
        f'https://meta.fabricmc.net/v2/versions/loader/{mc}/{loader}/server/json'
    )
    core = await versions.get_server_download(mc)
    bootstrap = await versions.get_fabric_download(mc, loader)
    data_dir = server_dir / '.fabric' / 'server'
    data_dir.mkdir(parents=True, exist_ok=True)
    launch = data_dir / f'fabric-loader-server-{loader}-minecraft-{mc}.jar'
    # Publish this readiness artifact only after every dependency is complete.
    launch.unlink(missing_ok=True)
    artifacts = [(core, data_dir / f'{mc}-server.jar')]
    libraries = []
    loader_file = None
    for lib in profile['libraries']:
        group, name, version = lib['name'].split(':', 2)
        relative = f'{group.replace(".", "/")}/{name}/{version}/{name}-{version}.jar'
        dest = server_dir / 'libraries' / relative.replace(' ', '_')
        if not dest.resolve().is_relative_to((server_dir / 'libraries').resolve()):
            raise ValueError('Invalid Fabric library path')
        artifacts.append(({**lib, 'url': lib['url'].rstrip('/') + '/' + relative}, dest))
        libraries.append(dest)
        if group == 'net.fabricmc' and name == 'fabric-loader':
            loader_file = dest
    artifacts.append((bootstrap, server_dir / 'server.jar'))
    total = sum(info.get('size', 0) or 0 for info, _ in artifacts)
    completed = 0
    for info, dest in artifacts:
        dest.parent.mkdir(parents=True, exist_ok=True)
        temporary = dest.with_name(dest.name + '.panel-download')
        algo = next((a for a in ('sha512', 'sha256', 'sha1') if info.get(a)), 'sha1')
        digest = info.get(algo, '')
        size = info.get('size', 0) or 0
        def report(downloaded, current_total):
            if progress:
                progress(completed + downloaded, max(total, completed + current_total))
        try:
            await jar_cache.cached_download(
                info['url'], temporary, algo=algo, hexhash=digest, size=size, progress=report,
            )
            # Also validate cache hits before publishing files consumed by Java.
            if digest and jar_cache.compute(temporary, algo) != digest:
                raise RuntimeError('Fabric 下载校验失败:哈希不匹配')
            if size and temporary.stat().st_size != size:
                raise RuntimeError('Fabric 下载校验失败:文件大小不匹配')
            downloaded = temporary.stat().st_size
            total += downloaded - size
            completed += downloaded
            temporary.replace(dest)
        finally:
            temporary.unlink(missing_ok=True)
    if loader_file is None:
        raise ValueError('Fabric metadata has no loader library')
    with ZipFile(loader_file) as jar:
        raw = jar.read('META-INF/MANIFEST.MF').replace(b'\r\n', b'\n').replace(b'\n ', b'')
        attrs = dict(line.split(b': ', 1) for line in raw.split(b'\n\n', 1)[0].split(b'\n') if b': ' in line)
        main_class = attrs[b'Main-Class'].decode('utf-8')
    # Match the official installer's legacy shaded launcher branch.
    release = loader.split('+', 1)[0].split('-', 1)[0]
    shaded = tuple(int(n) for n in release.split('.')[:3]) <= (0, 12, 5)
    classpath = '' if shaded else ' '.join('../../' + p.relative_to(server_dir).as_posix() for p in libraries)
    temporary = launch.with_suffix('.tmp')
    try:
        with ZipFile(temporary, 'w', ZIP_DEFLATED) as jar:
            jar.writestr('META-INF/MANIFEST.MF', _manifest({
                'Manifest-Version': '1.0', 'Main-Class': main_class, 'Class-Path': classpath,
            }))
            jar.writestr('fabric-server-launch.properties', f'launch.mainClass={profile["mainClass"]}\n')
            if shaded:
                services: dict[str, list[str]] = {}
                written = set(jar.namelist())
                for path in libraries:
                    with ZipFile(path) as lib:
                        for entry in lib.infolist():
                            name = entry.filename
                            if entry.is_dir() or re.fullmatch(r'META-INF/[^/]+\.(SF|DSA|RSA|EC)', name):
                                continue
                            if name.startswith('META-INF/services/'):
                                lines = services.setdefault(name, [])
                                for line in lib.read(entry).decode('utf-8').splitlines():
                                    line = line.split('#', 1)[0].strip()
                                    if line and line not in lines:
                                        lines.append(line)
                            elif name not in written:
                                jar.writestr(name, lib.read(entry))
                                written.add(name)
                for name, lines in services.items():
                    jar.writestr(name, '\n'.join(lines) + '\n')
        temporary.replace(launch)
    finally:
        temporary.unlink(missing_ok=True)
    if progress:
        progress(completed, completed)
