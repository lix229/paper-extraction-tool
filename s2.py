"""Semantic Scholar lookups and open-access PDF downloads."""
import hashlib
import html
import os
import re
import threading
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from urllib.parse import quote, urljoin

import httpx

API = 'https://api.semanticscholar.org/graph/v1'
FIELDS = ('paperId,title,year,authors,venue,externalIds,abstract,tldr,url,'
          'isOpenAccess,openAccessPdf,publicationTypes')
# Publishers refuse obvious scripts, so downloads present as a desktop browser.
BROWSER_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/130.0 Safari/537.36')
MAX_PDF_BYTES = 150 * 2**20
CONFIRM_SIMILARITY = 0.8

S2_PAPER_URL_RE = re.compile(r'semanticscholar\.org/paper/(?:[^/]+/)?([0-9a-f]{40})', re.I)
ARXIV_RE = re.compile(r'(?:arxiv\.org/(?:abs|pdf)/|^arxiv:\s*)(\d{4}\.\d{4,5})', re.I)
CITATION_PDF_RE = [
    re.compile(rb'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)', re.I),
    re.compile(rb'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url', re.I),
]


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class S2Error(Exception):
    """Semantic Scholar could not be reached; worth retrying later."""


class FetchError(Exception):
    def __init__(self, reason, url=None, status=None):
        super().__init__(reason)
        self.reason, self.url, self.status = reason, url, status


def normalize_title(title):
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', (title or '').lower()).split())


def title_similarity(a, b):
    return SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()


def parse_identifier(text):
    """Turn a pasted DOI, URL or id into a Semantic Scholar paper id such as 'DOI:10.1/x'."""
    text = text.strip()
    if not text:
        return None
    if m := S2_PAPER_URL_RE.search(text):
        return m.group(1)
    if re.fullmatch(r'[0-9a-f]{40}', text, re.I):
        return text
    if m := re.search(r'pubmed\.ncbi\.nlm\.nih\.gov/(\d+)', text) or re.fullmatch(r'(?:PMID:\s*)(\d+)', text, re.I):
        return f'PMID:{m.group(1)}'
    if m := ARXIV_RE.search(text):
        return f'ARXIV:{m.group(1)}'
    if m := re.fullmatch(r'CorpusId:\s*(\d+)', text, re.I):
        return f'CorpusId:{m.group(1)}'
    doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', text, flags=re.I)
    if re.fullmatch(r'10\.\d{4,9}/\S+', doi):
        return f'DOI:{doi}'
    return None


class S2Client:
    """Serialises calls so the keyed limit (1 request/second) is never exceeded."""

    def __init__(self, api_key=None, min_interval=1.1, timeout=30):
        self.min_interval = min_interval
        self.key_rejected = False
        self._lock = threading.Lock()
        self._last = 0.0
        headers = {'x-api-key': api_key} if api_key else {}
        self._http = httpx.Client(base_url=API, headers=headers, timeout=timeout)

    def _get(self, path, params):
        status = None
        attempt = 0
        while attempt < 4:
            with self._lock:
                wait = self._last + self.min_interval - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                try:
                    resp = self._http.get(path, params=params)
                except httpx.HTTPError as exc:
                    resp, status = None, type(exc).__name__
                finally:
                    self._last = time.monotonic()
            if resp is not None:
                status = resp.status_code
                if status == 404:
                    return None
                if status < 400:
                    return resp.json()
                if status == 403 and 'x-api-key' in self._http.headers:
                    # an invalid or revoked key; carry on with the shared keyless pool
                    del self._http.headers['x-api-key']
                    self.key_rejected = True
                    print('Semantic Scholar rejected the API key (HTTP 403); continuing without it.')
                    continue
                if status != 429 and status < 500:
                    raise S2Error(f'Semantic Scholar rejected the request (HTTP {status}): {resp.text[:200]}')
            time.sleep(2 * 2**attempt)
            attempt += 1
        raise S2Error(f'Semantic Scholar unavailable ({status}); try again later')

    def paper(self, s2_id):
        return self._get('/paper/' + quote(s2_id, safe=':/()'), {'fields': FIELDS})

    def title_match(self, title):
        data = self._get('/paper/search/match', {'query': title, 'fields': FIELDS})
        return data['data'][0] if data and data.get('data') else None


def resolve(client, paper, identifier=None):
    """Find the paper in Semantic Scholar. `identifier` overrides the workbook's DOI.

    Lookups by DOI or PubMed id are confirmed automatically when the titles agree;
    title-search matches and manual identifiers with mismatched titles need confirmation.
    """
    tried, data, method = [], None, None
    s2_id = identifier or paper['source'].get('s2_id')
    if s2_id:
        tried.append(s2_id)
        data = client.paper(s2_id)
        method = 'manual' if identifier else paper['source']['kind']
    if data is None and not identifier and paper['title']:
        tried.append('title search')
        data = client.title_match(paper['title'])
        method = 'title'
    if data is None:
        return {'status': 'not_found', 'tried': tried, 'confirmed': False, 'resolved_at': now()}
    similarity = title_similarity(paper['title'], data.get('title'))
    confirmed = method == 'manual' or (method in ('doi', 'pmid') and similarity >= CONFIRM_SIMILARITY)
    return {'status': 'matched', 'method': method, 'tried': tried, 'similarity': round(similarity, 3),
            'confirmed': confirmed, 'paper': data, 'resolved_at': now()}


def looks_like_pdf(head):
    # The PDF header may follow up to 1 KB of junk.
    return b'%PDF-' in head[:1024]


def _citation_pdf_url(body, base_url):
    for pattern in CITATION_PDF_RE:
        if m := pattern.search(body[:500_000]):
            return urljoin(base_url, html.unescape(m.group(1).decode('utf-8', 'replace')))
    return None


def _failure(status, ctype, url):
    if status in (401, 403):
        return FetchError(f'The publisher refused the automated download (HTTP {status}).', url, status)
    if status == 404:
        return FetchError('The open-access link is broken (HTTP 404).', url, status)
    if status in (202, 429, 503):
        return FetchError(f'The publisher showed a bot check instead of the PDF (HTTP {status}).', url, status)
    if status < 400 and 'html' in ctype:
        return FetchError('The link led to a web page, not a PDF.', url, status)
    return FetchError(f'Unexpected response (HTTP {status}, {ctype or "no content type"}).', url, status)


def _download(http, url, part_path):
    """Stream `url` into `part_path`. Returns (status, content type, final url, is_pdf, html head)."""
    with http.stream('GET', url) as resp:
        ctype = resp.headers.get('content-type', '').split(';')[0].lower()
        size, head = 0, b''
        with open(part_path, 'wb') as out:
            for chunk in resp.iter_bytes():
                if len(head) < 500_000:
                    head += chunk[:500_000 - len(head)]
                size += len(chunk)
                if size > MAX_PDF_BYTES:
                    raise FetchError(f'The file is larger than {MAX_PDF_BYTES // 2**20} MB.', url)
                out.write(chunk)
        return resp.status_code, ctype, str(resp.url), resp.status_code < 400 and looks_like_pdf(head), head


def download_pdf(url, dest, timeout=30):
    """Download an open-access PDF to `dest` (written atomically). Raises FetchError.

    When the link returns an article page instead, the page's citation_pdf_url
    meta tag is followed once.
    """
    part = dest.with_name(dest.name + '.part')
    headers = {'User-Agent': BROWSER_UA, 'Accept': '*/*'}
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as http:
            status, ctype, final_url, ok, head = _download(http, url, part)
            if not ok and status < 400 and 'html' in ctype:
                pdf_url = _citation_pdf_url(head, final_url)
                if pdf_url and pdf_url != final_url:
                    status, ctype, final_url, ok, _ = _download(http, pdf_url, part)
            if not ok:
                raise _failure(status, ctype, url)
    except httpx.TimeoutException:
        part.unlink(missing_ok=True)
        raise FetchError('The download timed out.', url)
    except httpx.HTTPError as exc:
        part.unlink(missing_ok=True)
        raise FetchError(f'Network error ({type(exc).__name__}).', url)
    except FetchError:
        part.unlink(missing_ok=True)
        raise
    sha = hashlib.sha256(part.read_bytes()).hexdigest()
    size = part.stat().st_size
    os.replace(part, dest)
    return {'url': url, 'final_url': final_url, 'sha256': sha, 'bytes': size, 'fetched_at': now()}
