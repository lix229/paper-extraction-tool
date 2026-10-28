"""On-disk storage: the paper cache and the extraction records.

data/
  cache/<record_id>/s2.json            Semantic Scholar match
  cache/<record_id>/paper.pdf          main PDF (downloaded or added by hand)
  cache/<record_id>/pdf.json           where the PDF came from, sha256, size, time
  cache/<record_id>/fetch_error.json   last failed download, cleared on success
  cache/<record_id>/supplements/*.pdf  supplementary files added by hand
  extractions/<record_id>.json         extraction record
  settings.json                        reviewer name
"""
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

from papers import RECORD_ID_RE
from s2 import looks_like_pdf, now

SUPPLEMENT_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}\.pdf$')


class Conflict(Exception):
    def __init__(self, current):
        super().__init__('record changed since it was loaded')
        self.current = current


class InvalidPdf(ValueError):
    pass


def write_json(path, obj):
    """Write via a temporary file so a crash never leaves half a file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text('utf-8'))
    except FileNotFoundError:
        return default


def safe_supplement_name(filename):
    stem = re.sub(r'[^A-Za-z0-9 ._()-]+', '_', Path(filename or 'supplement').stem).strip(' ._') or 'supplement'
    return stem[:90] + '.pdf'


class Store:
    def __init__(self, data_dir):
        self.root = Path(data_dir)
        self.cache = self.root / 'cache'
        self.extractions = self.root / 'extractions'
        self._lock = threading.Lock()

    def _dir(self, record_id):
        if not RECORD_ID_RE.match(record_id):
            raise ValueError(f'bad record id {record_id!r}')
        return self.cache / record_id

    # Semantic Scholar match

    def match(self, record_id):
        return read_json(self._dir(record_id) / 's2.json')

    def set_match(self, record_id, match):
        write_json(self._dir(record_id) / 's2.json', match)

    # main PDF

    def pdf_path(self, record_id):
        return self._dir(record_id) / 'paper.pdf'

    def pdf_info(self, record_id):
        if not self.pdf_path(record_id).is_file():
            return None
        return read_json(self._dir(record_id) / 'pdf.json', {'origin': 'unknown'})

    def fetch_error(self, record_id):
        return read_json(self._dir(record_id) / 'fetch_error.json')

    def set_fetch_error(self, record_id, error):
        write_json(self._dir(record_id) / 'fetch_error.json', {**error, 'at': now()})

    def record_downloaded_pdf(self, record_id, info):
        """Call after download_pdf() has written paper.pdf."""
        write_json(self._dir(record_id) / 'pdf.json', {'origin': 'semantic_scholar', **info})
        (self._dir(record_id) / 'fetch_error.json').unlink(missing_ok=True)

    def save_uploaded_pdf(self, record_id, data, filename):
        if not looks_like_pdf(data[:1024]):
            raise InvalidPdf('That file is not a PDF.')
        folder = self._dir(record_id)
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / 'paper.pdf.part'
        tmp.write_bytes(data)
        os.replace(tmp, folder / 'paper.pdf')
        info = {'origin': 'manual', 'filename': filename, 'sha256': hashlib.sha256(data).hexdigest(),
                'bytes': len(data), 'fetched_at': now()}
        write_json(folder / 'pdf.json', info)
        (folder / 'fetch_error.json').unlink(missing_ok=True)
        return info

    def discard_downloaded_pdf(self, record_id):
        """Drop a downloaded PDF and any failure (after the match changes). Manual PDFs stay."""
        info = self.pdf_info(record_id)
        if info and info.get('origin') == 'manual':
            return False
        folder = self._dir(record_id)
        for name in ('paper.pdf', 'pdf.json', 'fetch_error.json'):
            (folder / name).unlink(missing_ok=True)
        return True

    # supplements

    def supplements(self, record_id):
        folder = self._dir(record_id) / 'supplements'
        if not folder.is_dir():
            return []
        return [{'name': p.name, 'bytes': p.stat().st_size} for p in sorted(folder.glob('*.pdf'))]

    def supplement_path(self, record_id, name):
        if not SUPPLEMENT_NAME_RE.match(name):
            raise ValueError(f'bad supplement name {name!r}')
        return self._dir(record_id) / 'supplements' / name

    def save_supplement(self, record_id, data, filename):
        if not looks_like_pdf(data[:1024]):
            raise InvalidPdf('That file is not a PDF.')
        name = safe_supplement_name(filename)
        path = self.supplement_path(record_id, name)
        stem, n = path.stem, 2
        while path.exists():
            path = path.with_name(f'{stem} ({n}).pdf')
            n += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + '.part')
        tmp.write_bytes(data)
        os.replace(tmp, path)
        return {'name': path.name, 'bytes': len(data)}

    # extraction records

    def record(self, record_id):
        self._dir(record_id)  # validates the id
        return read_json(self.extractions / f'{record_id}.json')

    def all_records(self):
        if not self.extractions.is_dir():
            return {}
        return {p.stem: read_json(p) for p in self.extractions.glob('*.json')}

    def put_record(self, record_id, base_rev, fields):
        """Save `fields` (values, status, reviewer, config_*) if `base_rev` is current."""
        with self._lock:
            current = self.record(record_id)
            current_rev = current['rev'] if current else 0
            if base_rev != current_rev:
                raise Conflict(current)
            stamp = now()
            record = {
                'record_id': record_id,
                'rev': current_rev + 1,
                'created_at': current['created_at'] if current else stamp,
                'updated_at': stamp,
                **fields,
            }
            write_json(self.extractions / f'{record_id}.json', record)
            return record

    # settings

    def settings(self):
        return read_json(self.root / 'settings.json', {})

    def set_settings(self, settings):
        write_json(self.root / 'settings.json', settings)
