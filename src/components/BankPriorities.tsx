'use client';

import { ChevronRight, ExternalLink } from 'lucide-react';
import type { TerritoryPriority } from '@/lib/territory-priorities';
import type { Territory } from '@/lib/types';
import styles from './BankPriorities.module.css';

/** Keep administrative kind and ancestry from the same, unfiltered territory dataset. */
export type BankPriority = TerritoryPriority & Pick<Territory, 'kind' | 'parentId'>;
export type BankPrioritiesProps = {
  priorities: readonly BankPriority[];
  currentTerritoryId: string;
  onTerritory: (id: string) => void;
};

const labels: Record<TerritoryPriority['level'], string> = {
  develop: 'Есть потенциал',
  attention: 'Проверить присутствие',
  presence: 'Присутствие подтверждено',
  insufficient: 'Мало данных',
};

function compactFacts(priority: TerritoryPriority): string[] {
  const n = priority.numbers;
  const facts = [priority.facts[0], n.recentOpportunitySignals
    ? `Поводов проверить проекты — ${n.recentOpportunitySignals}; актуальная стадия отдельно подтверждена у ${n.currentStatusVerifiedSignals}.`
    : n.historicalOpportunitySignals
      ? `Исторических проектных публикаций — ${n.historicalOpportunitySignals}. Они не повышают текущий приоритет.`
      : 'Свежих проектных публикаций в наборе нет. Это не означает отсутствие проектов.'];
  if (n.unlocatedBankRecords || n.staleBankRecords) facts.push(`В текущие числа не включены: без достаточной географии или источника — ${n.unlocatedBankRecords}, без актуальной даты — ${n.staleBankRecords}.`);
  else if (n.undatedOpportunitySignals) facts.push(`Публикаций без корректной даты — ${n.undatedOpportunitySignals}; они не повышают приоритет.`);
  else if (n.duplicatesRemoved) facts.push(`Повторов по одному банку и месту объединено — ${n.duplicatesRemoved}.`);
  return facts.filter(Boolean);
}

function rankedTerritories(priorities: readonly BankPriority[], regionId: string) {
  const byId = new Map(priorities.map(priority => [priority.id, priority]));
  const inRegion = (priority: BankPriority) => {
    const seen = new Set<string>();
    let parent = priority.parentId;
    while (parent && !seen.has(parent)) {
      if (parent === regionId) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    return false;
  };
  return priorities.filter(priority => (priority.kind === 'district' || priority.kind === 'urban_district')
    && priority.level !== 'insufficient' && priority.score !== null && inRegion(priority))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
      || b.numbers.recentOpportunitySignals - a.numbers.recentOpportunitySignals
      || a.title.localeCompare(b.title, 'ru-RU'))
    .slice(0, 5);
}

function dateLabel(value: string | null) {
  if (!value) return 'Дата не указана';
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(time)
    : 'Дата не указана';
}

export default function BankPriorities({ priorities, currentTerritoryId, onTerritory }: BankPrioritiesProps) {
  const current = priorities.find(priority => priority.id === currentTerritoryId);
  if (!current) return <section className={styles.panel} aria-label="Банковский приоритет">
    <p className={styles.eyebrow}>Банковский приоритет</p>
    <h3 className={styles.headline}>Мало данных</h3>
    <p className={styles.note}>Для выбранной территории ещё нет результата проверки открытых источников.</p>
  </section>;

  const ranked = current.kind === 'region' ? rankedTerritories(priorities, current.id) : null;
  return <section className={styles.panel} aria-label={`Банковский приоритет: ${current.title}`}>
    <p className={styles.eyebrow}>Банковский приоритет</p>
    <h3 className={styles.headline} data-level={current.level}>{labels[current.level]}</h3>
    <p className={styles.scope}>{current.title} · по открытым данным</p>
    <ul className={styles.facts}>{compactFacts(current).map(fact => <li key={fact}>{fact}</li>)}</ul>
    <div className={styles.nextStep}><h4>Следующий шаг</h4><p>{current.nextStep}</p></div>

    {ranked && <div className={styles.ranking}>
      <h4>Где начать проверку</h4>
      <p className={styles.note}>Районы и городские округа: порядок по публичным поводам и подтверждённой географии банков.</p>
      {ranked.length ? <ol className={styles.list}>
        {ranked.map((priority, index) => <li key={priority.id}>
          <button type="button" className={styles.territory} onClick={() => onTerritory(priority.id)} aria-label={`Открыть ${priority.title}. ${labels[priority.level]}`}>
            <span className={styles.rank} aria-hidden="true">{index + 1}</span>
            <span className={styles.territoryText}><strong>{priority.title}</strong><small data-level={priority.level}>{labels[priority.level]}</small></span>
            <ChevronRight size={16} aria-hidden="true"/>
          </button>
        </li>)}
      </ol> : <p className={styles.empty}>Пока недостаточно данных, чтобы выделить территории для первоочередной проверки.</p>}
    </div>}

    <details className={styles.evidence} key={current.id}>
      <summary>Источники и ограничения{current.sources.length ? ` · ${current.sources.length}` : ''}</summary>
      <p className={styles.note}>{current.note}</p>
      <ul className={styles.evidenceFacts}>{current.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
      {current.sources.length ? <ul className={styles.sources}>{current.sources.map(source => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noreferrer"><span>{source.label}</span><ExternalLink size={13} aria-hidden="true"/><span className={styles.srOnly}> (в новой вкладке)</span></a>
        <small>{dateLabel(source.asOf)}</small>
      </li>)}</ul> : <p className={styles.note}>Подходящих источников для этого вывода пока нет.</p>}
    </details>
  </section>;
}
