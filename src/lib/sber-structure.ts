import type {BankOffice} from './types';
export const SBER_STRUCTURE_SOURCE='https://www.cbr.ru/finorg/foinfo/branches/?id=1315037838265';
export type SberHeadOffice=BankOffice&{role:'ТБ'|'ГОСБ';code:string};
/** Registry addresses and OSM address matches, verified 2026-09-05. */
export const SBER_HEAD_OFFICES:SberHeadOffice[]=[
  {id:'cbr-sber-937',bank:'sber',role:'ТБ',code:'937',name:'Волго-Вятский банк',address:'Нижний Новгород, улица Октябрьская, 35',territoryId:null,coordinates:[44.0099993,56.322071],precision:'building',sourceUrl:SBER_STRUCTURE_SOURCE,coordinateSourceUrl:'https://www.openstreetmap.org/relation/3573996',checkedAt:'2026-09-05'},
  {id:'cbr-sber-1466',bank:'sber',role:'ГОСБ',code:'8610',name:'Банк Татарстан №8610',address:'Казань, улица Бутлерова, 44',territoryId:'mo-92701000',coordinates:[49.138814,55.7893311],precision:'building',sourceUrl:SBER_STRUCTURE_SOURCE,coordinateSourceUrl:'https://www.openstreetmap.org/way/94694344',checkedAt:'2026-09-05'},
];
export function sberOfficeRole(office:BankOffice){return SBER_HEAD_OFFICES.find(item=>item.id===office.id)?.role??null;}
