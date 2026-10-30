#!/usr/bin/env python3
"""Local web server for the extraction tool.

    python3 server.py              # then open http://127.0.0.1:8765
    python3 server.py --port 9000 --data-dir /tmp/test-data

Settings live in config.yaml; the form is defined in form.yaml (re-read on every
page load). Publication details and PDFs are read from the papers directory.
"""
import argparse
import json
import mimetypes
import os
import re
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import yaml

from export import codebook_csv, export_csv
from formconfig import ConfigError, load_form_config
from papers import load_papers
from store import Conflict, InvalidPdf, Store

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
MAX_UPLOAD = 200 * 2**20
STATUSES = ['Not started', 'In progress', 'Needs review', 'Complete']
TYPES = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.ftl': 'text/plain; charset=utf-8',
         '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
         '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json'}


class HttpError(Exception):
    def __init__(self, status, message, payload=None):
        super().__init__(message)
        self.status, self.message, self.payload = status, message, payload


class App:
    def __init__(self, config_path, data_dir=None):
        self.config_path = Path(config_path).resolve()
        base = self.config_path.parent
        cfg = yaml.safe_load(self.config_path.read_text('utf-8'))
        p = cfg['papers']
        self.papers = load_papers(base / p['manifest'])
        self.by_id = {paper['record_id']: paper for paper in self.papers}
        self.form_path = base / cfg.get('form', 'form.yaml')
        self.store = Store(Path(data_dir) if data_dir else base / cfg.get('data_dir', 'data'),
                           base / p.get('directory', 'papers'), self.papers)
        self.server_cfg = cfg.get('server', {})

    def paper(self, rid):
        if rid not in self.by_id:
            raise HttpError(404, f'unknown record {rid}')
        return self.by_id[rid]

    def form(self):
        try:
            return load_form_config(self.form_path)
        except ConfigError as exc:
            raise HttpError(422, 'form.yaml has errors', {'errors': exc.errors})

    def pdf_state(self, rid):
        info = self.store.pdf_info(rid)
        error = None if info else {'reason': 'The PDF is missing. Add a copy below.'}
        return {'available': bool(info), **(info or {}), 'error': error}

    def summary(self, paper):
        rid = paper['record_id']
        record = self.store.record(rid) or {}
        pdf = self.pdf_state(rid)
        return {
            'record_id': rid, 'title': paper['title'], 'authors': paper['authors'], 'year': paper['year'],
            'source_label': paper['source']['label'],
            'status': record.get('status', 'Not started'), 'updated_at': record.get('updated_at'),
            'pdf': 'available' if pdf['available'] else 'missing',
        }

    def detail(self, rid):
        paper = self.paper(rid)
        return {
            'paper': paper, 'pdf': self.pdf_state(rid),
            'supplements': self.store.supplements(rid),
            'record': self.store.record(rid), 'summary': self.summary(paper),
        }

    def save_record(self, rid, body):
        self.paper(rid)
        form = self.form()
        status = body.get('status', 'Not started')
        if status not in STATUSES:
            raise HttpError(400, f'status must be one of {STATUSES}')
        values = body.get('values')
        if not isinstance(values, dict):
            raise HttpError(400, 'values must be an object')
        fields = {'status': status, 'reviewer': self.store.settings().get('reviewer', ''),
                  'config_version': form['version'], 'config_hash': form['hash'], 'values': values}
        try:
            rev = int(body.get('rev', 0))
        except (TypeError, ValueError):
            raise HttpError(400, 'rev must be an integer')
        try:
            return self.store.put_record(rid, rev, fields)
        except Conflict as exc:
            raise HttpError(409, 'This paper was saved from another tab or window.', {'current': exc.current})

    def export(self, ids):
        form = self.form()
        papers = [p for p in self.papers if ids is None or p['record_id'] in ids]
        records = {p['record_id']: self.store.record(p['record_id']) for p in papers}
        pdfs = {p['record_id']: self.store.pdf_info(p['record_id']) for p in papers}
        return export_csv(form, papers, records, pdfs)


ROUTES = []


def route(method, pattern):
    def register(fn):
        ROUTES.append((method, re.compile(pattern + '$'), fn))
        return fn
    return register


class Handler(BaseHTTPRequestHandler):
    app: App = None
    server_version = 'ExtractionTool/1.0'

    def log_message(self, fmt, *args):
        if os.environ.get('EXTRACTION_TOOL_QUIET'):
            return
        super().log_message(fmt, *args)

    def _dispatch(self, method):
        url = urlsplit(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
            if host not in ('127.0.0.1', 'localhost', '[::1]'):
                raise HttpError(403, 'only local requests are accepted')
            if method != 'GET' and self.headers.get('X-Extraction-Tool') != '1':
                raise HttpError(403, 'missing X-Extraction-Tool header')
            for m, pattern, fn in ROUTES:
                if m == method and (match := pattern.match(url.path)):
                    return fn(self, **{k: unquote(v) for k, v in match.groupdict().items()})
            if method == 'GET':
                return self.static(url.path)
            raise HttpError(404, 'not found')
        except HttpError as exc:
            self.json({'error': exc.message, **(exc.payload or {})}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            self.json({'error': f'{type(exc).__name__}: {exc}'}, 500)

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    # helpers

    def body_bytes(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_UPLOAD:
            raise HttpError(413, f'files over {MAX_UPLOAD // 2**20} MB are not accepted')
        return self.rfile.read(length)

    def body_json(self):
        try:
            return json.loads(self.body_bytes() or b'{}')
        except json.JSONDecodeError:
            raise HttpError(400, 'request body is not JSON')

    def send(self, status, data, ctype, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj, status=200):
        self.send(status, json.dumps(obj, ensure_ascii=False).encode(), 'application/json; charset=utf-8')

    def file(self, path, ctype):
        if not path.is_file():
            raise HttpError(404, 'file not found')
        self.send(200, path.read_bytes(), ctype, {'Content-Disposition': 'inline'})

    def static(self, path):
        rel = 'index.html' if path in ('/', '/index.html') else path.removeprefix('/static/')
        if rel == path:
            raise HttpError(404, 'not found')
        target = (STATIC / unquote(rel)).resolve()
        if not target.is_relative_to(STATIC) or not target.is_file():
            raise HttpError(404, 'not found')
        ctype = TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        if ctype.startswith('text/') and 'charset' not in ctype:
            ctype += '; charset=utf-8'
        self.send(200, target.read_bytes(), ctype)

    def filename_header(self):
        return unquote(self.headers.get('X-Filename') or 'upload.pdf')


@route('GET', r'/api/config')
def get_config(h):
    h.json(h.app.form())


@route('GET', r'/api/settings')
def get_settings(h):
    h.json({**h.app.store.settings(), 'statuses': STATUSES})


@route('PUT', r'/api/settings')
def put_settings(h):
    body = h.body_json()
    reviewer = str(body.get('reviewer', '')).strip()
    if not reviewer:
        raise HttpError(400, 'reviewer name is required')
    h.app.store.set_settings({**h.app.store.settings(), 'reviewer': reviewer})
    get_settings(h)


@route('GET', r'/api/papers')
def list_papers(h):
    h.json([h.app.summary(p) for p in h.app.papers])


@route('GET', r'/api/papers/(?P<rid>[^/]+)')
def get_paper(h, rid):
    h.json(h.app.detail(rid))


@route('GET', r'/api/papers/(?P<rid>[^/]+)/pdf')
def get_pdf(h, rid):
    h.app.paper(rid)
    h.file(h.app.store.pdf_path(rid), 'application/pdf')


@route('PUT', r'/api/papers/(?P<rid>[^/]+)/pdf')
def put_pdf(h, rid):
    h.app.paper(rid)
    try:
        h.app.store.save_uploaded_pdf(rid, h.body_bytes(), h.filename_header())
    except InvalidPdf as exc:
        raise HttpError(400, str(exc))
    h.json(h.app.detail(rid))


@route('PUT', r'/api/papers/(?P<rid>[^/]+)/supplements')
def put_supplement(h, rid):
    h.app.paper(rid)
    try:
        h.app.store.save_supplement(rid, h.body_bytes(), h.filename_header())
    except InvalidPdf as exc:
        raise HttpError(400, str(exc))
    h.json(h.app.detail(rid))


@route('GET', r'/api/papers/(?P<rid>[^/]+)/supplements/(?P<name>[^/]+)')
def get_supplement(h, rid, name):
    h.app.paper(rid)
    try:
        path = h.app.store.supplement_path(rid, name)
    except ValueError as exc:
        raise HttpError(400, str(exc))
    h.file(path, 'application/pdf')


@route('PUT', r'/api/records/(?P<rid>[^/]+)')
def put_record(h, rid):
    h.json(h.app.save_record(rid, h.body_json()))


@route('GET', r'/api/export\.csv')
def get_export(h):
    ids = set(filter(None, h.query['ids'].split(','))) if 'ids' in h.query else None
    stamp = datetime.now().strftime('%Y%m%d-%H%M')
    h.send(200, h.app.export(ids).encode('utf-8'), 'text/csv; charset=utf-8',
           {'Content-Disposition': f'attachment; filename="extraction_{stamp}.csv"'})


@route('GET', r'/api/codebook\.csv')
def get_codebook(h):
    h.send(200, codebook_csv(h.app.form()).encode('utf-8'), 'text/csv; charset=utf-8',
           {'Content-Disposition': 'attachment; filename="extraction_codebook.csv"'})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', default=ROOT / 'config.yaml', type=Path)
    parser.add_argument('--data-dir', type=Path, help='override data_dir from config.yaml')
    parser.add_argument('--port', type=int)
    args = parser.parse_args()

    app = App(args.config, args.data_dir)
    try:
        app.form()
    except HttpError as exc:
        print('form.yaml has errors (the page will list them):\n  ' + '\n  '.join(exc.payload['errors']))
    Handler.app = app
    host = app.server_cfg.get('host', '127.0.0.1')
    port = args.port or int(app.server_cfg.get('port', 8765))
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f'{len(app.papers)} papers loaded; data in {app.store.root}')
    print(f'Open http://{host}:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
