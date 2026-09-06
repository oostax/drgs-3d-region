export type DossierBrief={goal:string;participants:string;notes:string};
/** Existing free-form notes stay intact; structured notes are a display convention, not a migration. */
export function parseDossierBrief(notes:string):DossierBrief{
  const match=notes.match(/^Цель встречи:\n([\s\S]*?)\n\nУчастники:\n([\s\S]*?)\n\nЗаметки:\n([\s\S]*)$/);
  return match?{goal:match[1],participants:match[2],notes:match[3]}:{goal:'',participants:'',notes};
}
export function serializeDossierBrief(brief:DossierBrief){return `Цель встречи:\n${brief.goal}\n\nУчастники:\n${brief.participants}\n\nЗаметки:\n${brief.notes}`;}
