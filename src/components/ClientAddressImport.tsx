'use client';
import {useEffect,useRef,useState} from 'react';
import type {ClientAddressImportResult} from '@/lib/client-address-import';
type Result=ClientAddressImportResult&{restored?:boolean};
export default function ClientAddressImport({onImported}:{onImported:()=>void}){
  const [file,setFile]=useState<File|null>(null),[result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[visibleRows,setVisibleRows]=useState(100);
  const request=useRef<AbortController|null>(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  async function submit(apply:boolean){
    if(!file||request.current||apply&&(!result?.valid||result.applied))return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    try{
      const data=new FormData();data.set('file',file);data.set('mode','work');data.set('apply',String(apply));
      const response=await fetch('/api/client-addresses',{method:'POST',body:data,signal:controller.signal});
      const body=await response.json();if(!response.ok)throw new Error(body.error||'Файл не обработан');
      if(controller.signal.aborted)return;setResult(body);setVisibleRows(100);if(apply)onImported();
    }catch(error){if(!controller.signal.aborted)setError((error as Error).message);}
    finally{if(!controller.signal.aborted)setBusy(false);if(request.current===controller)request.current=null;}
  }
  async function restore(){
    if(!result?.importId||request.current||result.restored)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    try{
      const response=await fetch('/api/client-addresses',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'work',importId:result.importId}),signal:controller.signal});
      const body=await response.json();if(!response.ok)throw new Error(body.error||'Не удалось отменить импорт');
      if(controller.signal.aborted)return;setResult({...result,restored:true});onImported();
    }catch(error){if(!controller.signal.aborted)setError((error as Error).message);}
    finally{if(!controller.signal.aborted)setBusy(false);if(request.current===controller)request.current=null;}
  }
  const candidates=result?.rows.filter(row=>['candidate','preserved'].includes(row.status)).length??0;
  return <details className="client-import">
    <summary>Загрузить адреса клиентов</summary>
    <p className="caption">CSV или XLSX для существующих клиентов: ИНН, название, ГОСБ, адрес и тип адреса. Координаты необязательны. Файл обрабатывается локально.</p>
    <a className="text-button" href="/api/client-addresses?mode=work&template=1" download>Скачать шаблон CSV</a>
    <label className="field">Файл адресов<input type="file" accept=".csv,.xlsx" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]||null);setResult(null);setVisibleRows(100);setError('');}}/></label>
    <button className="secondary" disabled={!file||busy} onClick={()=>submit(false)}>{busy?'Обрабатываем…':'Проверить файл'}</button>
    {error&&<p role="alert" className="error">{error}</p>}
    {result&&<div className="client-import-result">
      <p>Строк: {result.total} · принято: {result.valid} · с точкой: {result.located} · требуют выбора: {candidates}</p>
      <details><summary>Проверить строки и решения ({result.rows.length})</summary>
        <ol className="caption">{result.rows.slice(0,visibleRows).map(row=><li key={row.row}>
          <strong>Строка {row.row} · {row.portfolioName||row.name||row.inn}</strong><br/>
          ИНН {row.inn} · {row.addressKind==='office'?'Офис':'Юридический адрес'} · {row.address}<br/>
          {row.coordinates?`${row.coordinates[0]}, ${row.coordinates[1]} · `:''}{row.message}
        </li>)}</ol>
        {result.rows.length>visibleRows&&<button className="secondary" onClick={()=>setVisibleRows(count=>count+100)}>Показать ещё {Math.min(100,result.rows.length-visibleRows)} строк</button>}
      </details>
      {result.errors.slice(0,8).map((message,i)=><p className="caption" key={i}>{message}</p>)}
      {result.restored?<p role="status">Импорт отменён. Прежние адреса восстановлены.</p>:result.applied?<>
        <p role="status">Адреса сохранены. Клиентский слой обновлён.</p>
        {result.importId&&<button className="secondary" disabled={busy} onClick={restore}>Отменить этот импорт</button>}
      </>:<>
        <p className="caption">Адреса без координат останутся в списке. При неоднозначности появятся кандидаты; сохранённые и подтверждённые адреса останутся на месте.</p>
        <button className="primary" disabled={busy||!result.valid} onClick={()=>submit(true)}>Сохранить {result.valid} записей</button>
      </>}
    </div>}
  </details>;
}
