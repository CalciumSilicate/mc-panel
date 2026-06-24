"""轻量 async Source RCON 客户端(零第三方依赖)。

世界地图的玩家位置采集走 RCON:面板用本客户端连到实例的 rcon 端口,执行
``list`` / ``data get entity <name> Pos`` 等只读查询,命令与返回**不经过**
MCDR 的 stdin/stdout,因而不污染控制台与日志。

协议(Valve Source RCON):每个包为
    int32(LE) length | int32(LE) request_id | int32(LE) type | body(utf-8, \0) | \0
type:3=AUTH(登录) / 2=EXEC(执行命令,登录响应也是 2) / 0=RESPONSE(命令返回)。
登录失败时服务端回包的 request_id 为 -1。
"""
from __future__ import annotations

import asyncio
import struct

_TYPE_AUTH = 3
_TYPE_EXEC = 2
_TYPE_RESPONSE = 0


class RconError(Exception):
    """RCON 连接/执行失败(含超时、连接拒绝)。"""


class RconAuthError(RconError):
    """RCON 密码错误(服务端返回 request_id == -1)。"""


def _encode(req_id: int, ptype: int, body: str) -> bytes:
    payload = struct.pack("<ii", req_id, ptype) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


async def _read_packet(reader: asyncio.StreamReader) -> tuple[int, int, str]:
    (length,) = struct.unpack("<i", await reader.readexactly(4))
    data = await reader.readexactly(length)
    req_id, ptype = struct.unpack("<ii", data[:8])
    body = data[8:-2].decode("utf-8", errors="replace")  # 去掉 body 尾随的两个 \0
    return req_id, ptype, body


class RconClient:
    """单连接 RCON 客户端;建议用 ``async with`` 或一次性的 :func:`query`。"""

    def __init__(self, host: str, port: int, password: str, timeout: float = 3.0) -> None:
        self._host = host
        self._port = port
        self._password = password
        self._timeout = timeout
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def __aenter__(self) -> "RconClient":
        await self.connect()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def connect(self) -> None:
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self._host, self._port), self._timeout
            )
        except (OSError, asyncio.TimeoutError) as exc:
            raise RconError(f"无法连接 RCON {self._host}:{self._port}: {exc}") from exc
        await self._authenticate()

    async def _authenticate(self) -> None:
        assert self._reader is not None and self._writer is not None
        self._writer.write(_encode(0, _TYPE_AUTH, self._password))
        await self._writer.drain()
        # 登录后服务端可能先回一个空 RESPONSE,再回 AUTH 响应;读到 type==2 为准。
        try:
            while True:
                req_id, ptype, _ = await asyncio.wait_for(
                    _read_packet(self._reader), self._timeout
                )
                if ptype == _TYPE_EXEC:  # AUTH 响应与 EXEC 同号(2)
                    if req_id == -1:
                        raise RconAuthError("RCON 密码错误")
                    return
        except asyncio.TimeoutError as exc:
            raise RconError("RCON 登录超时") from exc
        except (asyncio.IncompleteReadError, OSError) as exc:
            raise RconError(f"RCON 登录失败: {exc}") from exc

    async def command(self, cmd: str) -> str:
        if self._reader is None or self._writer is None:
            raise RconError("RCON 未连接")
        self._writer.write(_encode(1, _TYPE_EXEC, cmd))
        await self._writer.drain()
        try:
            _req_id, _ptype, body = await asyncio.wait_for(
                _read_packet(self._reader), self._timeout
            )
        except asyncio.TimeoutError as exc:
            raise RconError("RCON 命令超时") from exc
        except (asyncio.IncompleteReadError, OSError) as exc:
            raise RconError(f"RCON 命令失败: {exc}") from exc
        return body

    async def close(self) -> None:
        if self._writer is not None:
            try:
                self._writer.close()
                await asyncio.wait_for(self._writer.wait_closed(), self._timeout)
            except (OSError, asyncio.TimeoutError):
                pass
            finally:
                self._reader = None
                self._writer = None


async def query(
    host: str, port: int, password: str, command: str, timeout: float = 3.0
) -> str:
    """一次性建连执行单条命令并返回响应文本。"""
    async with RconClient(host, port, password, timeout) as client:
        return await client.command(command)
