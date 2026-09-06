"""Shared local runtime directories; never evaluate shell syntax in .env.local."""
from pathlib import Path
import os
import re

APP_ROOT = Path(os.environ.get('ATLAS_APP_ROOT') or Path(__file__).resolve().parents[2]).resolve()

def load_local_env(path: Path = APP_ROOT / '.env.local') -> int:
    if not path.exists():
        return 0
    loaded = 0
    for line in path.read_text().splitlines():
        line = line.strip().removeprefix('export ')
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r'ATLAS_[A-Z0-9_]+', key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key not in os.environ:
            os.environ[key] = value
            loaded += 1
    return loaded

load_local_env()
DATA_ROOT = Path(os.environ.get('ATLAS_DATA_ROOT') or APP_ROOT)
if not DATA_ROOT.is_absolute():
    raise ValueError('ATLAS_DATA_ROOT must be absolute')

def data_path(*parts: str) -> Path:
    return DATA_ROOT.joinpath(*parts)

def public_path(name: str) -> Path:
    candidate = data_path('public', 'data', name)
    return candidate if candidate.exists() else APP_ROOT / 'public' / 'data' / name
