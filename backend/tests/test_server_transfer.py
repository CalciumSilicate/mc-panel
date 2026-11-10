import io
import json
from pathlib import Path
import tarfile
import time
import unittest
from unittest.mock import patch
import zipfile

import httpx
from fastapi import HTTPException

from app import server_import, server_transfer
from app.models import Server
from app.database import get_db
import test_uploads


class TransferTests(unittest.TestCase):
    setUp = test_uploads.UploadTests.setUp
    create = test_uploads.UploadTests.create
    chunk = test_uploads.UploadTests.chunk
    finish = test_uploads.UploadTests.finish
    make_package = test_uploads.UploadTests.make_package

    def wait(self, uid):
        for _ in range(200):
            state=self.client.get(f'/uploads/{uid}').json()
            if state['status']!='processing': return state
            time.sleep(.02)
        self.fail('transfer timed out')

    def automatic(self,data,name):
        uid=self.create(name=name,size=len(data),kind='package',server_id=None)
        self.assertEqual(self.chunk(uid,data).status_code,200)
        result=self.finish(uid)
        self.assertEqual(result['status'],'done',result)
        with self.sessions() as db:
            server=db.get(Server,result['server_id'])
            db.expunge(server)
            return server

    def test_zip_auto_detects_and_resolves_name_port_conflicts(self):
        first=self.automatic(self.make_package(),'server.zip')
        second=self.automatic(self.make_package(),'server.zip')
        self.assertEqual(first.mc_version,'1.21.1')
        self.assertNotEqual(first.name,second.name)
        self.assertNotEqual(first.port,second.port)
        self.assertFalse(second.auto_start)

    def test_tar_and_targz_import(self):
        source=zipfile.ZipFile(io.BytesIO(self.make_package()))
        for mode,name in [('w','test.tar'),('w:gz','test.tar.gz')]:
            out=io.BytesIO()
            with tarfile.open(fileobj=out,mode=mode) as archive:
                directory=tarfile.TarInfo('.');directory.type=tarfile.DIRTYPE
                archive.addfile(directory)
                for entry in source.infolist():
                    data=source.read(entry)
                    info=tarfile.TarInfo('./'+entry.filename);info.size=len(data)
                    archive.addfile(info,io.BytesIO(data))
            server=self.automatic(out.getvalue(),name)
            self.assertEqual((self.servers/server.dir_name/'server/world/level.dat').read_bytes(),b'world-data')

    def test_native_rar_and_7z_decoders(self):
        fixtures=Path(__file__).parent/'fixtures/server_archives'
        for name,entry,size in [('test_read_format_7zip_lzma1.7z','file1',2844),('test_read_format_rar5_compressed.rar','test.bin',1200),('test_read_format_rar5_stored.rar','helloworld.txt',29)]:
            target=self.root/name
            server_import.extract(fixtures/name,target,lambda *args:None)
            self.assertEqual((target/entry).stat().st_size,size)

    def test_tar_links_and_traversal_rejected(self):
        for index,name in enumerate(['../escape','/absolute','safe/link']):
            out=io.BytesIO()
            with tarfile.open(fileobj=out,mode='w') as archive:
                info=tarfile.TarInfo(name)
                if index==2:info.type=tarfile.SYMTYPE;info.linkname='../../outside'
                archive.addfile(info)
            source=self.root/f'bad{index}.tar';source.write_bytes(out.getvalue())
            with self.assertRaises(HTTPException):
                server_import.extract(source,self.root/f'out{index}',lambda *args:None)
        self.assertFalse((self.root/'escape').exists())

    def test_local_browse_and_import_preserve_source(self):
        source=self.root/'my-server'
        source.mkdir()
        with zipfile.ZipFile(io.BytesIO(self.make_package())) as archive:
            archive.extractall(source)
        folder=source/'pack'
        original=(folder/'server.properties').read_bytes()
        response=self.client.get('/uploads/local-directories',params={'path':str(source.resolve())})
        self.assertEqual(response.status_code,200,response.text)
        self.assertIn('pack',[d['name'] for d in response.json()['directories']])
        response=self.client.post('/uploads/import',json={'source':'local','path':str(folder.resolve())})
        self.assertEqual(response.status_code,202,response.text)
        state=self.wait(response.json()['id'])
        self.assertEqual(state['status'],'done',state)
        self.assertEqual((folder/'server.properties').read_bytes(),original)
        self.assertTrue((folder/'server.jar').exists())

    def test_mcdr_custom_working_directory_and_launch_metadata(self):
        import yaml
        source=self.root/'mcd'
        (source/'game').mkdir(parents=True)
        jar=io.BytesIO()
        with zipfile.ZipFile(jar,'w') as archive:archive.writestr('version.json',json.dumps({'id':'26.3'}))
        (source/'game/core.jar').write_bytes(jar.getvalue())
        (source/'game/other.jar').write_bytes(b'unrelated')
        (source/'game/server.properties').write_text('server-port=25588\nmotd=keep\n')
        (source/'config.yml').write_text(yaml.safe_dump({'working_directory':'game','start_command':'java -Xms2G -Xmx4G -Dfile.encoding=UTF-8 -jar core.jar nogui','language':'zh_cn','plugin_directories':['custom_plugins']}))
        (source/'custom_plugins').mkdir();(source/'custom_plugins/test.mcdr').write_bytes(b'plugin')
        options=server_import.detect(source,'detected',{'min_memory':'1G','max_memory':'2G'})
        self.assertEqual((options['mc_version'],options['port'],options['min_memory'],options['max_memory']),('26.3',25588,'2G','4G'))
        self.assertEqual(options['launch_jar'],'core.jar')
        target=self.root/'prepared'
        server_import.prepare(source,target,options,'java')
        self.assertEqual((target/'plugins/test.mcdr').read_bytes(),b'plugin')
        cfg=yaml.safe_load((target/'config.yml').read_text())
        self.assertEqual(cfg['working_directory'],'server')
        self.assertIn('-Dfile.encoding=UTF-8',cfg['start_command'])

    def test_legacy_core_reads_world_version(self):
        import nbtlib
        source=self.root/'legacy'
        (source/'world').mkdir(parents=True)
        (source/'server.jar').write_bytes(b'legacy-core')
        nbtlib.File({'Data':nbtlib.Compound({'Version':nbtlib.Compound({'Name':nbtlib.String('1.12.2')})})}).save(source/'world/level.dat',gzipped=True)
        options=server_import.detect(source,'legacy',{'min_memory':'1G','max_memory':'2G'})
        self.assertEqual(options['mc_version'],'1.12.2')

    def test_url_import_and_http_size_limit(self):
        data=self.make_package()
        transport=httpx.MockTransport(lambda request:httpx.Response(200,content=data))
        client=httpx.Client(transport=transport)
        with patch('app.server_transfer.httpx.Client',return_value=client):
            response=self.client.post('/uploads/import',json={'source':'url','url':'https://example.test/server.zip'})
            self.assertEqual(response.status_code,202,response.text)
            state=self.wait(response.json()['id'])
        self.assertEqual(state['status'],'done',state)
        self.assertEqual(self.client.post('/uploads/import',json={'source':'url','url':'file:///etc/passwd'}).status_code,400)
        with patch('app.uploads.MAX_BYTES',2),patch('app.server_transfer.httpx.Client',return_value=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,content=b'123')))):
            with self.assertRaises(HTTPException):server_transfer.download('https://example.test/x',self.root/'big',lambda *args:None)

    def test_export_roundtrip_download_and_permissions(self):
        server=self.automatic(self.make_package(),'original.zip')
        def database():
            with self.sessions() as db:yield db
        self.client.app.dependency_overrides[get_db]=database
        with patch('app.mcdr.manager.get_status',return_value='running'):
            self.assertEqual(self.client.post(f'/uploads/export/{server.id}').status_code,409)
        with patch('app.mcdr.manager.get_status',return_value='stopped'):
            response=self.client.post(f'/uploads/export/{server.id}')
            self.assertEqual(response.status_code,202,response.text)
            state=self.wait(response.json()['id'])
        self.assertEqual(state['status'],'done',state)
        link=self.client.post(f"/uploads/{state['id']}/download-link").json()['url'].removeprefix('/api')
        self.assertEqual(self.client.get(link.replace('ticket=','ticket=invalid')).status_code,403)
        package=self.client.get(link)
        self.assertEqual(package.status_code,200)
        copy=self.automatic(package.content,'copy.zip')
        self.assertEqual(copy.mc_version,server.mc_version)
        self.assertNotEqual(copy.port,server.port)
        self.assertEqual((self.servers/copy.dir_name/'server/world/level.dat').read_bytes(),b'world-data')
        self.user.role='helper'
        self.assertEqual(self.client.get('/uploads/local-directories').status_code,403)
        self.assertEqual(self.client.post(f'/uploads/export/{server.id}').status_code,403)
        self.assertEqual(self.client.post('/uploads/import',json={'source':'local','path':str(self.root)}).status_code,403)
