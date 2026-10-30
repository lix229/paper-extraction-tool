import csv
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from papers import load_papers
from server import App, Handler, HttpError

ROOT = Path(__file__).resolve().parent.parent
PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


def test_paper_manifest_matches_the_bundle():
    papers = load_papers(ROOT / 'papers/manifest.json')
    assert len(papers) == 60
    assert {p['record_id'] for p in papers} == {p.stem for p in (ROOT / 'papers').glob('*.pdf')}
    for paper in papers:
        raw = (ROOT / 'papers' / (paper['record_id'] + '.pdf')).read_bytes()
        assert len(raw) == paper['pdf_bytes']
        assert hashlib.sha256(raw).hexdigest() == paper['pdf_sha256']
    entries = json.loads((ROOT / 'papers/manifest.json').read_text())
    publication_fields = {'record_id', 'title', 'authors', 'year', 'abstract', 'doi', 'pdf_sha256', 'pdf_bytes'}
    assert all(set(entry) == publication_fields for entry in entries)


@pytest.mark.parametrize('change', [
    {'record_id': '../outside'}, {'record_id': '..'}, {'record_id': '.'},
    {'title': ''}, {'pdf_sha256': 'bad'}, {'pdf_bytes': -1},
])
def test_manifest_rejects_invalid_entries(tmp_path, change):
    entry = {'record_id': 'R1', 'title': 'Example', 'pdf_sha256': 'a' * 64, 'pdf_bytes': 123}
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps([{**entry, **change}]))
    with pytest.raises(ValueError):
        load_papers(manifest)


def test_manifest_rejects_duplicate_ids(tmp_path):
    entry = {'record_id': 'R1', 'title': 'Example', 'pdf_sha256': 'a' * 64, 'pdf_bytes': 123}
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps([entry, entry]))
    with pytest.raises(ValueError, match='duplicate record id'):
        load_papers(manifest)


def test_reviewers_start_fresh_and_save_independently(tmp_path):
    first = App(ROOT / 'config.yaml', tmp_path / 'first')
    second = App(ROOT / 'config.yaml', tmp_path / 'second')
    assert first.store.settings() == second.store.settings() == {}
    assert all(first.summary(p)['status'] == 'Not started' for p in first.papers)
    assert all(first.detail(p['record_id'])['pdf']['available'] for p in first.papers)
    assert not first.store.root.exists()  # reading papers does not create progress

    rid = first.papers[0]['record_id']
    first.store.set_settings({'reviewer': 'Reviewer A'})
    saved = first.save_record(rid, {'rev': 0, 'status': 'In progress', 'values': {'decision': 'Include'}})
    assert saved['rev'] == 1 and saved['reviewer'] == 'Reviewer A'
    assert second.detail(rid)['record'] is None
    resumed = App(ROOT / 'config.yaml', tmp_path / 'first')
    assert resumed.detail(rid)['record']['values']['decision'] == 'Include'
    with pytest.raises(HttpError) as error:
        first.save_record(rid, {'rev': 0, 'status': 'Complete', 'values': {}})
    assert error.value.status == 409

    rows = list(csv.DictReader(io.StringIO(first.export(None).lstrip('\ufeff'))))
    assert len(rows) == 60
    assert rows[0]['record_id'] == rid and rows[0]['reviewer'] == 'Reviewer A'
    assert rows[0]['pdf_sha256'] == first.papers[0]['pdf_sha256']
    assert rows[1]['status'] == 'Not started' and rows[1]['decision'] == ''
    assert len(list(csv.DictReader(io.StringIO(first.export({rid}).lstrip('\ufeff'))))) == 1
    assert list(csv.DictReader(io.StringIO(first.export(set()).lstrip('\ufeff')))) == []


def test_pdf_replacement_preserves_the_shared_paper(tmp_path):
    app = App(ROOT / 'config.yaml', tmp_path / 'local')
    other = App(ROOT / 'config.yaml', tmp_path / 'other')
    rid = app.papers[0]['record_id']
    bundled = app.store.pdf_path(rid)
    before = hashlib.sha256(bundled.read_bytes()).hexdigest()
    assert app.store.pdf_info(rid)['origin'] == 'bundled'
    app.store.save_uploaded_pdf(rid, PDF, 'replacement.pdf')
    assert app.store.pdf_path(rid).read_bytes() == PDF
    assert app.store.pdf_info(rid)['filename'] == 'replacement.pdf'
    assert app.store.pdf_path(rid).is_relative_to(app.store.root)
    assert hashlib.sha256(bundled.read_bytes()).hexdigest() == before
    assert other.store.pdf_path(rid) == bundled
    assert other.store.pdf_info(rid)['sha256'] == before


def test_http_review_round_trip(tmp_path):
    """Exercise HTTP parsing and routes with an in-memory connection."""
    class LocalHandler(Handler):
        app = App(ROOT / 'config.yaml', tmp_path / 'review')

        def setup(self):
            self.rfile = io.BytesIO(self.request.raw)
            self.wfile = io.BytesIO()

        def finish(self):
            self.request.response = self.wfile.getvalue()

        def log_message(self, *_):
            pass

    def request(method, path, body=None):
        payload = json.dumps(body).encode() if body is not None else b''
        headers = (f'{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n'
                   f'X-Extraction-Tool: 1\r\nContent-Length: {len(payload)}\r\n\r\n')
        connection = SimpleNamespace(raw=headers.encode() + payload)
        LocalHandler(connection, ('127.0.0.1', 12345), None)
        head, data = connection.response.split(b'\r\n\r\n', 1)
        return int(head.split()[1]), data

    status, html = request('GET', '/')
    assert status == 200 and b'id="paper-abstract"' in html
    status, data = request('GET', '/api/papers')
    papers = json.loads(data)
    assert status == 200 and len(papers) == 60
    assert all(p['status'] == 'Not started' and p['pdf'] == 'available' for p in papers)
    rid = papers[0]['record_id']
    status, data = request('GET', f'/api/papers/{rid}/pdf')
    assert status == 200 and hashlib.sha256(data).hexdigest() == LocalHandler.app.papers[0]['pdf_sha256']
    status, data = request('PUT', '/api/settings', {'reviewer': 'Reviewer B'})
    assert status == 200 and json.loads(data)['reviewer'] == 'Reviewer B'
    status, data = request('PUT', f'/api/records/{rid}', {
        'rev': 0, 'status': 'In progress', 'values': {'decision': 'Include'},
    })
    assert status == 200 and json.loads(data)['reviewer'] == 'Reviewer B'
    status, data = request('GET', f'/api/papers/{rid}')
    assert status == 200 and json.loads(data)['record']['values']['decision'] == 'Include'
    status, data = request('GET', f'/api/export.csv?ids={rid}')
    rows = list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'))))
    assert status == 200 and len(rows) == 1
    assert rows[0]['record_id'] == rid and rows[0]['decision'] == 'Include'
    assert request('GET', '/api/papers/unknown')[0] == 404
