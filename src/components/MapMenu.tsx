import {Map,Radio,Building2,Landmark,BriefcaseBusiness,Play,X,ChevronRight,Database} from 'lucide-react';
import type {AtlasMapLayers} from './AtlasMap';
import type {View} from '@/lib/types';
import {IconButton} from './ui';

export default function MapMenu({layers,pitch,perspective,onPerspective,onSources,onToggle,onFocus,onAll,onPitch,onClose,onTour}:{layers:AtlasMapLayers;pitch:number;perspective:'region'|'sber';onPerspective:(value:'region'|'sber')=>void;onSources:()=>void;onToggle:(key:keyof AtlasMapLayers,value:boolean)=>void;onFocus:(view:View)=>void;onAll:()=>void;onPitch:(pitch:number)=>void;onClose:()=>void;onTour:()=>void}){
  return <section className="map-menu glass" aria-label="Содержимое карты">
    <div className="section-line"><h3>Карта</h3><IconButton label="Закрыть меню карты" onClick={onClose}><X size={18}/></IconButton></div>
    <div className="map-priority"><span>Приоритет обзора</span><div className="filter-chips" aria-label="Приоритет карты">{(['region','sber'] as const).map(value=><button key={value} aria-pressed={perspective===value} className={perspective===value?'selected':''} onClick={()=>onPerspective(value)}>{value==='region'?'Регион':'Сбер'}</button>)}</div><p>{perspective==='region'?'Сначала потребности и проблемы территории.':'Сначала сигналы с возможностью участия Сбера.'}</p></div>
    {([{key:'signals',view:'signals',label:'Сигналы',Icon:Radio},{key:'banks',view:'banks',label:'Банки',Icon:Building2},{key:'landmarks',view:'places',label:'Места',Icon:Landmark}] as const).map(({key,view,label,Icon})=><div className="map-menu-layer" key={key}><button onClick={()=>onFocus(view)}><Icon size={19}/><span>{label}</span><ChevronRight size={15}/></button><label className="switch-row"><input aria-label={`Показывать: ${label}`} type="checkbox" checked={layers[key]} onChange={e=>onToggle(key,e.target.checked)}/></label></div>)}
    <button className="map-menu-link" onClick={()=>onFocus('organizations')}><BriefcaseBusiness size={19}/><span>Организации и возможности</span><ChevronRight size={15}/></button>
    <button className="map-menu-link" onClick={onAll}><Map size={19}/><span>Показать все слои</span></button>
    <details className="map-menu-settings"><summary>Вид карты</summary>{([{key:'buildings',label:'Здания'},{key:'boundaries',label:'Границы территорий'},{key:'terrain',label:'Рельеф'}] as const).map(({key,label})=><label className="switch-row" key={key}><span>{label}</span><input type="checkbox" checked={layers[key]} onChange={e=>onToggle(key,e.target.checked)}/></label>)}<label className="field compact">Наклон<input aria-label="Наклон камеры" type="range" min={0} max={65} step={5} value={pitch} onChange={e=>onPitch(Number(e.target.value))}/></label></details>
    <a className="map-menu-link" href="/scenes"><Play size={19}/><span>Галерея сцен</span><ChevronRight size={15}/></a>
    <button className="map-menu-link" onClick={onSources}><Database size={19}/><span>Источники и покрытие</span><ChevronRight size={15}/></button>
    <button className="map-menu-link" onClick={onTour}><Play size={19}/><span>Презентационный маршрут</span><ChevronRight size={15}/></button>
  </section>;
}
