import type {Coordinates,Precision} from './types';
export type ClientMapPoint={id:string;inn:string;name:string;gosb:string;address:string;addressKind:'legal'|'office'|'meeting';coordinates:Coordinates;precision:Precision;sourceUrl:string;confirmedByUser:boolean};
export type ClientMapPayload={items:ClientMapPoint[];total:number;located:number;unlocated:number;portfolioInns:string[]};
