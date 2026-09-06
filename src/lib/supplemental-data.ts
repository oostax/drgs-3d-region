import {all,one,hasTable,safeJson} from './db';
import {currentSourceId} from './source-status';
import type {Mode} from './types';
export function supplementalOverview(mode:Mode){
 if(mode==='public'||!hasTable('source_records'))return null;
 const kinds=['client_cards','model_details','july_results','mood_survey'];
 return kinds.map(kind=>{const id=currentSourceId(kind);if(!id)return {kind,status:'missing'};
 const row=one<{file_name:string;rows_read:number;rows_kept:number;report_json:string}>('SELECT file_name,rows_read,rows_kept,report_json FROM imports WHERE id=?',id)!;
 const report=safeJson<Record<string,unknown>>(row.report_json,{});
 return {kind,status:'complete',fileName:row.file_name,rowsRead:row.rows_read,rowsKept:row.rows_kept,quality:report.quality,pilot:report.pilot_identity_counts??report.counters,questions:report.questions,scale:report.scale,aggregation:'Источники и версии показываются отдельно; строки модели не суммируются с портфелем.',amountUnit:kind==='model_details'?'Единица суммы требует подтверждения':null};});
}
export function organizationSupplement(inn:string,gosb:string){
 if(!hasTable('source_records'))return null;
 const cards=currentSourceId('client_cards'),model=currentSourceId('model_details');
 const cardRows=cards?all<{data_json:string}>('SELECT data_json FROM source_records WHERE source_id=? AND inn=? AND gosb=? ORDER BY entity_id LIMIT 40',cards,inn,gosb):[];
 const modelCount=model?one<{n:number}>('SELECT COUNT(*) n FROM source_records WHERE source_id=? AND inn=? AND gosb=?',model,inn,gosb)?.n??0:0;
 return {cards:cardRows.map(r=>{const v=safeJson<Record<string,unknown>>(r.data_json,{});return {epk:v['ЕПК ID'],rep:v['REP ID'],kpp:v['КПП'],kind:v['Тип карточки'],manager:v['КМ'],priority:v['Приоритет'],liquidation:v['Статус ликвидации']};}),modelRows:modelCount,note:'Карточки филиалов и юрлица разделены. Адрес из принадлежности к ГОСБ не выводится.'};
}
