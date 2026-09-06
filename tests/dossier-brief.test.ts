import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDossierBrief,serializeDossierBrief} from '../src/lib/dossier-brief';

test('meeting purpose, participants and notes use one lossless format for editor and print',()=>{
  const brief={goal:'Обсудить два предложения.\nУточнить сроки.',participants:'Представитель организации — уточнить\nМенеджер — уточнить',notes:'Решение пока не принято.\n\nМатериалы представлены клиентом.'};
  assert.deepEqual(parseDossierBrief(serializeDossierBrief(brief)),brief);
});
test('old free-form notes remain notes without invented purpose or participants',()=>{
  for(const notes of ['', 'Следующая встреча в октябре', 'Участники: ещё не определены\n\nСохранить прежнюю запись.']){
    assert.deepEqual(parseDossierBrief(notes),{goal:'',participants:'',notes});
  }
});
