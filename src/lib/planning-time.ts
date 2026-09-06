/** Next weekday in Moscow; public holidays and participant availability are not inferred. */
export function nextWeekdayStart(now=new Date()){
  const local=new Date(now.getTime()+3*3600000);local.setUTCDate(local.getUTCDate()+1);
  while(local.getUTCDay()===0||local.getUTCDay()===6)local.setUTCDate(local.getUTCDate()+1);
  return local.toISOString().slice(0,10)+'T09:00';
}
