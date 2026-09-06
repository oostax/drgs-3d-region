#!/usr/bin/env python3
"""Split audited signals into publish, priority review, context, and noise."""
from __future__ import annotations
import argparse,csv,json,sqlite3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
def main():
    p=argparse.ArgumentParser();p.add_argument('--audit',type=Path,default=ROOT/'artifacts/signal-audit.json');p.add_argument('--db',type=Path,default=ROOT/'data/live/atlas-live.sqlite');p.add_argument('--output',type=Path,default=ROOT/'artifacts/signal-triage.csv');a=p.parse_args()
    audited=json.loads(a.audit.read_text(encoding='utf-8'))
    c=sqlite3.connect(a.db);c.row_factory=sqlite3.Row
    events={r['id']:json.loads(r['data_json'] or '{}') for r in c.execute('SELECT id,data_json FROM events WHERE deleted=0')}
    out=[]
    for row in audited['signals']:
        if row['auditResult']!='needs_review': bucket='publish_now'
        else:
            u=events.get(row['id'],{}).get('signalUsefulness') or {}; d=u.get('dimensions') or {}
            if u.get('level')=='noise': bucket='hide_noise'
            elif d.get('actionability',0)>=2 or d.get('specificity',0)>=2 or d.get('significance',0)>=2: bucket='priority_review'
            else: bucket='context'
        out.append({**row,'triage':bucket})
    a.output.parent.mkdir(parents=True,exist_ok=True)
    # URL probes can add `sourceProbeError` only to unreachable rows.  Build
    # the schema from the full set, otherwise the CSV is silently truncated at
    # the first such row and no longer represents the audit population.
    fieldnames=list(dict.fromkeys(key for row in out for key in row))
    with a.output.open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fieldnames,extrasaction='ignore');w.writeheader();w.writerows(out)
    from collections import Counter
    print(json.dumps({'rows':len(out),'buckets':dict(Counter(x['triage'] for x in out))},ensure_ascii=False))
if __name__=='__main__':main()
