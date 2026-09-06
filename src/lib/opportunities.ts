import type {Organization} from './types';
import type {Opportunity} from './planning-types';
const money=(value:number)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(value)+' ₽';
/** Rules expose their evidence. They do not predict eligibility or approved limits. */
export function organizationOpportunities(org:Organization):Opportunity[]{
  const results:Opportunity[]=[];
  const current=(org.offers||[]).filter(offer=>offer.snapshot==='current');
  const products=[...new Set(current.map(offer=>offer.product).filter(Boolean))];
  if(current.length)results.push({id:`${org.id}:current-offers`,orgId:org.id,rule:'current_offers',title:'Продвинуть предложения в работе',priority:'high',facts:[`В последнем срезе у организации ${current.length} предложений.`,...(org.expectedIncome!==null?[`ОД в выбранном срезе: ${money(org.expectedIncome)}; это ожидаемый, а не полученный доход.`]:[])],hypothesis:'Встреча может помочь уточнить потребность и согласовать следующий шаг по существующим предложениям.',products:products.slice(0,5),nextStep:'Уточнить статус, ответственного и препятствия по каждому предложению; согласовать следующий шаг с клиентом.',sourceLabels:['Текущие предложения ГОСБ 8610; предполагаемая дата среза']});
  const payroll=org.payroll;
  if(payroll&&payroll.fot_march!==null&&payroll.fot_july!==null&&payroll.fot_march>0&&payroll.fot_july>payroll.fot_march){
    const growth=(payroll.fot_july/payroll.fot_march-1)*100;
    results.push({id:`${org.id}:payroll-growth`,orgId:org.id,rule:'payroll_growth',title:'Обсудить изменение зарплатных выплат',priority:'medium',facts:[`ФОТ за март: ${money(payroll.fot_march)}; за июль: ${money(payroll.fot_july)}.`,`Рост между двумя месяцами: ${growth.toFixed(1)}%. Причина изменения неизвестна.`],hypothesis:'Изменение выплат может создать потребность в зарплатном проекте или автоматизации расчётов. Рост сам по себе не доказывает расширение штата.',products:['Зарплатный проект','Расчётное обслуживание'],nextStep:'Уточнить сезонность, премии и состав выплат; проверить действующий договор и применимость продукта к организации.',sourceLabels:['Объём ФОТ · март и июль · рубли','https://developers.sber.ru/docs/ru/sber-api/scenarios/salary/salary-project/overview']});
  }
  const meetings=org.meetings;
  if(meetings&&meetings.conflict===0&&[meetings.q1,meetings.q2,meetings.q3].every(value=>value===0))results.push({id:`${org.id}:no-meetings`,orgId:org.id,rule:'no_meetings',title:'Уточнить контакт и запланировать встречу',priority:current.length?'high':'medium',facts:['В предоставленных счётчиках I, II и III кварталов указаны нулевые встречи.','Отсутствие записей не доказывает отсутствие контактов вне этой выгрузки.'],hypothesis:'Полезно уточнить контактный план и текущие задачи организации перед новым предложением.',products:products.length?products.slice(0,3):['Расчётное обслуживание — после уточнения потребности'],nextStep:'Проверить актуальность счётчика и закрепление КМ; согласовать тему, место и время встречи.',sourceLabels:['Встречи · один счётчик на ИНН + ГОСБ; год предполагается']});
  return results;
}
