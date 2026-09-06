"""Versioned, lossless private staging for card exports, model facts, July views and surveys.
These independent snapshots are never added to the portfolio aggregates.
"""
import csv
import io
import json
import re
from collections import Counter

DDL = '''
CREATE TABLE IF NOT EXISTS source_records (
 source_id TEXT NOT NULL REFERENCES imports(id), kind TEXT NOT NULL, sheet TEXT NOT NULL,
 row_number INTEGER NOT NULL, inn TEXT, gosb TEXT, entity_id TEXT, data_json TEXT NOT NULL,
 PRIMARY KEY(source_id,sheet,row_number));
CREATE INDEX IF NOT EXISTS source_records_identity ON source_records(kind,inn,gosb);
'''


def identifier(value):
    text = '' if value is None else str(value).strip()
    return text[:-2] if text.endswith('.0') else text


def prepare(importer):
    importer.conn.executescript(DDL)
    # Reprocessing only replaces the same immutable source hash.
    importer.conn.execute('DELETE FROM source_records WHERE source_id=?', (importer.source_id,))
    importer.report['aggregation'] = 'independent_snapshot_do_not_add'
    importer.report['amount_unit'] = 'unconfirmed' if importer.report['kind'] == 'model_details' else None


def record(importer, kind, sheet, number, values):
    from import_xlsx import normalize_inn, gosb_identifier
    inn = identifier(values.get('ИНН', values.get('inn')))
    inn, issue = normalize_inn(inn)
    if issue: importer.quality[issue] += 1
    gosb = gosb_identifier(values.get('ГОСБ', values.get('gosb_id')))
    if inn and not re.fullmatch(r'\d{10}|\d{12}', inn): importer.quality['invalid_inn_length'] += 1
    entity_id = identifier(values.get('ЕПК ID', values.get('product_offer_system_id')))
    importer.conn.execute('INSERT OR REPLACE INTO source_records VALUES(?,?,?,?,?,?,?,?)',
        (importer.source_id,kind,sheet,number,inn or None,gosb or None,entity_id or None,json.dumps(values,ensure_ascii=False)))
    importer.rows_kept += 1
    if gosb == '8610': importer.counters['pilot_records'] += 1


def import_supplement(importer, path, kind, open_workbook):
    prepare(importer)
    if kind == 'mood_survey':
        # Export is CP1251 tab-separated despite its .csv extension.
        raw = path.read_bytes()
        try: text = raw.decode('utf-8-sig')
        except UnicodeDecodeError: text = raw.decode('cp1251')
        reader = csv.DictReader(io.StringIO(text,newline=''),delimiter='\t')
        importer.report['headers']['survey'] = reader.fieldnames
        questions = [key for key in reader.fieldnames if '/Страница' in key and not key.startswith('Комментарий/')]
        counts = {key: Counter() for key in questions}
        by_status = Counter()
        for number, values in enumerate(reader,2):
            importer.rows_read += 1
            record(importer,kind,'survey',number,values)
            by_status[values.get('Статус прохожения','')] += 1
            for question in questions:
                score = identifier(values.get(question))
                if score in ('1','2','3'): counts[question][score] += 1
                elif score: importer.quality['invalid_score'] += 1
        importer.report['scale'] = {'1':'плохо','2':'нормально','3':'отлично'}
        importer.report['response_statuses'] = dict(by_status)
        importer.report['questions'] = [{'question':key.split('/')[0], 'respondents':sum(count.values()),
            'counts':{str(score):count[str(score)] for score in (1,2,3)},
            'average':sum(int(score)*n for score,n in count.items())/sum(count.values()) if count else None} for key,count in counts.items()]
    else:
        with open_workbook(path,importer.temp_dir) as workbook:
            importer.report['sheets'] = [{key:value for key,value in sheet.items() if key!='path'} for sheet in workbook.sheets]
            for sheet in workbook.sheets:
                header = None
                for number, values in workbook.rows(sheet):
                    if not header:
                        header = values; importer.report['headers'][sheet['name']] = header; continue
                    if not any(value is not None and str(value).strip() for value in values.values()): continue
                    importer.rows_read += 1
                    named = {str(header.get(col) or col):value for col,value in values.items()}
                    record(importer,kind,sheet['name'],number,named)
                    if importer.rows_read % importer.progress_every == 0: importer.progress()
    if kind == 'client_cards':
        row = importer.conn.execute("SELECT COUNT(*),COUNT(DISTINCT inn),COUNT(DISTINCT entity_id) FROM source_records WHERE source_id=? AND gosb='8610'",(importer.source_id,)).fetchone()
        importer.report['pilot_identity_counts'] = dict(zip(('cards','distinct_inns','distinct_epk_ids'),row))
        importer.report['identity_rule'] = 'legal=INN; servicing=INN+GOSB; card=EPK/REP/KPP; no automatic address inference'
    importer.progress('complete')
    return {'file_name':path.name,'status':'complete','rows_read':importer.rows_read,'rows_kept':importer.rows_kept,'report':importer.report}
