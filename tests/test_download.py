"""download_pdf() against a local server that imitates publisher behaviour."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from s2 import FetchError, download_pdf

PDF = b'%PDF-1.5\n' + b'x' * 2000 + b'\n%%EOF\n'


class Publisher(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, ctype):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/paper.pdf':
            self.reply(200, PDF, 'application/pdf')
        elif self.path == '/article':
            self.reply(200, b'<html><head><meta name="citation_pdf_url" content="/paper.pdf"></head></html>', 'text/html')
        elif self.path == '/landing':
            self.reply(200, b'<html><body>Article</body></html>', 'text/html')
        elif self.path == '/forbidden':
            self.reply(403, b'<html>Access denied</html>', 'text/html')
        elif self.path == '/challenge':
            self.reply(202, b'<html>Checking your browser</html>', 'text/html')
        elif self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/paper.pdf')
            self.end_headers()
        else:
            self.reply(404, b'missing', 'text/plain')


@pytest.fixture(scope='module')
def base_url():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Publisher)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown()


def test_direct_and_redirected_pdf(base_url, tmp_path):
    for path in ('/paper.pdf', '/redirect'):
        dest = tmp_path / 'paper.pdf'
        info = download_pdf(base_url + path, dest)
        assert dest.read_bytes() == PDF and info['bytes'] == len(PDF) and info['final_url'].endswith('/paper.pdf')


def test_follows_citation_pdf_url(base_url, tmp_path):
    dest = tmp_path / 'paper.pdf'
    download_pdf(base_url + '/article', dest)
    assert dest.read_bytes() == PDF


@pytest.mark.parametrize('path, reason', [
    ('/landing', 'web page, not a PDF'),
    ('/forbidden', 'refused the automated download (HTTP 403)'),
    ('/challenge', 'bot check'),
    ('/nothing', 'broken (HTTP 404)'),
])
def test_failures_leave_no_file(base_url, tmp_path, path, reason):
    dest = tmp_path / 'paper.pdf'
    with pytest.raises(FetchError) as info:
        download_pdf(base_url + path, dest)
    assert reason in info.value.reason
    assert not dest.exists() and not list(tmp_path.iterdir())
