from pathlib import Path

import pytest

from papers import load_papers, normalize_doi, parse_source
from s2 import parse_identifier, title_similarity
from store import Conflict, InvalidPdf, Store

ROOT = Path(__file__).resolve().parent.parent
PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


def test_parse_source_kinds():
    assert parse_source('10.1049/htl2.70021')['s2_id'] == 'DOI:10.1049/htl2.70021'
    assert parse_source('https://doi.org/10.1000/ABC(1)')['url'] == 'https://doi.org/10.1000/ABC(1)'
    pm = parse_source('https://pubmed.ncbi.nlm.nih.gov/38827053/')
    assert pm['kind'] == 'pmid' and pm['s2_id'] == 'PMID:38827053'
    assert parse_source(None)['kind'] == 'missing'
    assert parse_source('see notes')['kind'] == 'unknown'
    assert normalize_doi('doi: 10.1000/x') == '10.1000/x'


@pytest.mark.skipif(not (ROOT.parent / 'included_papers_n63.xlsx').exists(), reason='screening workbook not present')
def test_workbook_loads_63_papers():
    papers = load_papers(ROOT.parent / 'included_papers_n63.xlsx', 'Articles',
                         {'id': 'record_id', 'title': 'title', 'authors': 'authors', 'year': 'year',
                          'doi': 'doi', 'abstract': 'abstract'}, ['review_aspect', 'decision'])
    kinds = [p['source']['kind'] for p in papers]
    assert len(papers) == 63
    assert (kinds.count('doi'), kinds.count('pmid'), kinds.count('missing')) == (61, 1, 1)
    assert papers[0]['screening']['decision'] == 'Include'


def test_parse_identifier():
    assert parse_identifier('https://doi.org/10.1000/xyz') == 'DOI:10.1000/xyz'
    assert parse_identifier('PMID: 123') == 'PMID:123'
    assert parse_identifier('https://pubmed.ncbi.nlm.nih.gov/456/') == 'PMID:456'
    assert parse_identifier('https://arxiv.org/abs/2401.01234v2') == 'ARXIV:2401.01234'
    sha = 'a' * 40
    assert parse_identifier(f'https://www.semanticscholar.org/paper/Some-Title/{sha}') == sha
    assert parse_identifier('nonsense') is None


def test_title_similarity_ignores_case_and_punctuation():
    assert title_similarity('A Deep-Learning Approach!', 'a deep learning approach') == 1.0
    assert title_similarity('Bone fractures', '2025 SAGES Annual Meeting') < 0.5


def test_record_revisions(tmp_path):
    store = Store(tmp_path)
    first = store.put_record('R1', 0, {'status': 'In progress', 'values': {'a': 1}})
    assert first['rev'] == 1
    second = store.put_record('R1', 1, {'status': 'Complete', 'values': {'a': 2}})
    assert second['rev'] == 2 and second['created_at'] == first['created_at']
    with pytest.raises(Conflict) as info:
        store.put_record('R1', 1, {'status': 'In progress', 'values': {}})
    assert info.value.current['rev'] == 2
    assert not list((tmp_path / 'extractions').glob('*.tmp'))


def test_record_id_validation(tmp_path):
    store = Store(tmp_path)
    for bad in ('../etc', 'a/b', ''):
        with pytest.raises(ValueError):
            store.record(bad)


def test_pdf_upload_and_supplements(tmp_path):
    store = Store(tmp_path)
    with pytest.raises(InvalidPdf):
        store.save_uploaded_pdf('R1', b'<html>login</html>', 'x.pdf')
    info = store.save_uploaded_pdf('R1', PDF, 'paper.pdf')
    assert info['origin'] == 'manual' and store.pdf_info('R1')['sha256'] == info['sha256']
    assert store.discard_downloaded_pdf('R1') is False  # manual PDFs are kept
    a = store.save_supplement('R1', PDF, '../../Appendix S1.pdf')
    b = store.save_supplement('R1', PDF, 'Appendix S1.pdf')
    assert a['name'] == 'Appendix S1.pdf' and b['name'] == 'Appendix S1 (2).pdf'
    assert [s['name'] for s in store.supplements('R1')] == ['Appendix S1 (2).pdf', 'Appendix S1.pdf']
    with pytest.raises(ValueError):
        store.supplement_path('R1', '../paper.pdf')
