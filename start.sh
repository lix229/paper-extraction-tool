#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

python_cmd=${PYTHON:-python3}
if ! command -v "$python_cmd" >/dev/null 2>&1; then
    echo 'Install Python 3.9 or newer, then run ./start.sh again.' >&2
    exit 1
fi
"$python_cmd" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "Python 3.9 or newer is required.")'

if [ ! -x .venv/bin/python ]; then
    "$python_cmd" -m venv .venv
fi
if ! .venv/bin/python -c 'import yaml; from importlib.metadata import version; assert int(version("PyYAML").split(".")[0]) >= 6' >/dev/null 2>&1; then
    .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python server.py "$@"
