export function number(value:number|null|undefined){return value==null?'Нет данных':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(value);}
export function money(value:number|null|undefined){if(value==null)return 'Нет данных';const a=Math.abs(value);return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:a>=1e6?1:0}).format(a>=1e9?value/1e9:a>=1e6?value/1e6:a>=1e3?value/1e3:value)+(a>=1e9?' млрд ₽':a>=1e6?' млн ₽':a>=1e3?' тыс. ₽':' ₽');}
export function shortDate(value:string|null|undefined){if(!value)return 'Дата не указана';const d=new Date(value);return Number.isNaN(+d)?value:d.toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'});}
export function shortDateTime(value:string|null|undefined){
  if(!value)return 'Дата не указана';
  const timestamp=/[T ]\d{1,2}:\d{2}/.test(value);
  const zoned=timestamp&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)?value.replace(' ','T')+'+03:00':value;
  const d=new Date(zoned);if(Number.isNaN(+d))return value;
  const date=d.toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Moscow'});
  if(!/[T ]\d{1,2}:\d{2}/.test(value))return `${date} · время не указано`;
  const time=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
  return `${date} · ${time} МСК`;
}
export function publicationDateTime(value:string|null|undefined){
  if(!value)return 'Дата публикации не указана';
  const timestamp=/[T ]\d{1,2}:\d{2}/.test(value);
  const zoned=timestamp&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)?value.replace(' ','T')+'+03:00':value;
  const d=new Date(zoned);if(Number.isNaN(+d))return value;
  const date=d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'});
  if(!timestamp)return `${date} · время не указано`;
  const time=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
  return `${date} · ${time} МСК`;
}
