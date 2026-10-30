"""Load publication details from the paper manifest."""
import json
import re
from pathlib import Path
from urllib.parse import quote

DOI_RE = re.compile(r'^10\.\d{4,9}/\S+$')
DOI_PREFIX_RE = re.compile(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', re.I)
PUBMED_RE = re.compile(r'pubmed\.ncbi\.nlm\.nih\.gov/(\d+)')
RECORD_ID_RE = re.compile(r'^[A-Za-z0-9._-]{1,80}$')


def clean(value):
    return '' if value is None else str(value).strip()


def normalize_doi(text):
    doi = DOI_PREFIX_RE.sub('', text.strip())
    return doi if DOI_RE.match(doi) else None


def parse_source(raw):
    raw = clean(raw)
    if not raw:
        return {'kind': 'missing', 'raw': '', 'url': None, 'label': 'No DOI'}
    match = PUBMED_RE.search(raw)
    if match:
        pmid = match.group(1)
        return {'kind': 'pmid', 'raw': raw, 'url': f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/',
                'label': f'PubMed {pmid}'}
    doi = normalize_doi(raw)
    if doi:
        return {'kind': 'doi', 'raw': raw, 'doi': doi,
                'url': 'https://doi.org/' + quote(doi, safe='/:;()._-'), 'label': f'DOI {doi}'}
    if raw.startswith(('http://', 'https://')):
        return {'kind': 'url', 'raw': raw, 'url': raw, 'label': 'Source link'}
    return {'kind': 'unknown', 'raw': raw, 'url': None, 'label': raw}


def load_papers(path):
    """Read the manifest, retaining publication fields and PDF checksums."""
    path = Path(path)
    entries = json.loads(path.read_text('utf-8'))
    if not isinstance(entries, list) or not entries:
        raise ValueError(f'{path.name}: expected a nonempty list of papers')
    papers, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f'{path.name}: each paper must be an object')
        rid = clean(entry.get('record_id'))
        if not RECORD_ID_RE.fullmatch(rid) or rid in ('.', '..'):
            raise ValueError(f'{path.name}: invalid record id {rid!r}')
        if rid in seen:
            raise ValueError(f'{path.name}: duplicate record id {rid}')
        title = clean(entry.get('title'))
        sha256 = clean(entry.get('pdf_sha256'))
        size = entry.get('pdf_bytes')
        if not title:
            raise ValueError(f'{path.name}: {rid} needs a title')
        if not re.fullmatch(r'[0-9a-f]{64}', sha256):
            raise ValueError(f'{path.name}: {rid} needs a PDF SHA-256 checksum')
        if type(size) is not int or size <= 0:
            raise ValueError(f'{path.name}: {rid} needs a positive PDF size')
        seen.add(rid)
        papers.append({
            'record_id': rid, 'title': title, 'authors': clean(entry.get('authors')),
            'year': clean(entry.get('year')), 'abstract': clean(entry.get('abstract')),
            'source': parse_source(entry.get('doi')),
            'pdf_sha256': sha256, 'pdf_bytes': size,
        })
    return papers
