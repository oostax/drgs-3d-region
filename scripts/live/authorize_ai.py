#!/usr/bin/env python3
"""Record explicit user authorization for AI clarification of significant signals."""
from __future__ import annotations
import argparse,datetime,json,sqlite3
from pathlib import Path
from worker import DEFAULT_DB,REGISTRY

def main():
 p=argparse.ArgumentParser();p.add_argument('--db',type=Path,default=DEFAULT_DB);p.add_argument('--registry',type=Path,default=REGISTRY);a=p.parse_args()
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with sqlite3.connect(a.db) as c:
  backup=a.db.parent.parent/'backups'/('live-before-ai-authorization-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite');backup.parent.mkdir(parents=True,exist_ok=True)
  with sqlite3.connect(backup) as b:c.backup(b)
  n=c.execute("UPDATE sources SET ai_allowed=1,rights_note=rights_note||' AI-анализ разрешён пользователем для уточнения значимых сигналов (глобальная авторизация '+?+').' WHERE fetch_allowed=1 AND display_allowed=1 AND ai_allowed=0",(stamp,)).rowcount
  c.commit()
 raw=json.loads(a.registry.read_text(encoding='utf-8')); sources=raw['sources'] if isinstance(raw,dict) else raw
 changed=0
 for s in sources:
  if s.get('fetch_allowed') and s.get('display_allowed') and not s.get('ai_allowed'):
   s['ai_allowed']=True;s['rights_note']=(s.get('rights_note','')+' AI-анализ разрешён пользователем для уточнения значимых сигналов ('+stamp+').').strip();changed+=1
 a.registry.write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print(json.dumps({'dbSourcesChanged':n,'registrySourcesChanged':changed,'backup':str(backup)},ensure_ascii=False))
if __name__=='__main__':main()
