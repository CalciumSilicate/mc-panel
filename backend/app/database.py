"""SQLAlchemy 引擎与会话(SQLite,单节点)。"""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DB_PATH, ensure_dirs

ensure_dirs()

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI 依赖:每个请求一个会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    # 确保模型已注册到 metadata
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_columns()


# 新增字段时在此登记:create_all 不会给已存在的表补列,这里用 ALTER TABLE 补齐。
_COLUMN_MIGRATIONS = {
    "servers": {
        "extra_jvm_args": "VARCHAR(1024) DEFAULT ''",
        "auto_start": "BOOLEAN DEFAULT 0",
        "java_path_override": "VARCHAR(512) DEFAULT ''",
        "protected": "BOOLEAN DEFAULT 0",
        "loader_version": "VARCHAR(64) DEFAULT ''",
        "group_id": "INTEGER",
        "proxy_id": "INTEGER",
    },
    "system_settings": {
        "download_proxy": "VARCHAR(255) DEFAULT ''",
        "allow_register": "BOOLEAN DEFAULT 0",
        "onebot_enabled": "BOOLEAN DEFAULT 0",
        "onebot_ws_url": "VARCHAR(255) DEFAULT 'ws://127.0.0.1:3001'",
        "onebot_token": "VARCHAR(255) DEFAULT ''",
        "port_min": "INTEGER DEFAULT 25565",
        "port_max": "INTEGER DEFAULT 25999",
        "base_url": "VARCHAR(255) DEFAULT ''",
    },
    "server_groups": {
        "qq_group_ids": "TEXT DEFAULT '[]'",
    },
    "archives": {
        "owner_user_id": "INTEGER",
    },
    "users": {
        "verified": "BOOLEAN DEFAULT 0",
        "player_id": "VARCHAR(64) DEFAULT ''",
        "verify_code": "VARCHAR(16) DEFAULT ''",
        "verify_target": "VARCHAR(64) DEFAULT ''",
    },
}


def _migrate_columns() -> None:
    from sqlalchemy import text

    with engine.begin() as conn:
        for table, columns in _COLUMN_MIGRATIONS.items():
            existing = {
                row[1] for row in conn.execute(text(f'PRAGMA table_info("{table}")'))
            }
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {name} {ddl}'))
