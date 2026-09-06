"use client";
import { useEffect, useState } from "react";
import { FileText, Plus, Printer, Save, Check } from "lucide-react";
import { Dossier, Mode } from "@/lib/types";
import { shortDate } from "@/lib/format";
import { Back, Empty, Source } from "./ui";
import {parseDossierBrief as meetingBrief,serializeDossierBrief as briefNotes} from '@/lib/dossier-brief';
type DossierEditorProps={mode:Mode;territoryId:string;signalIds:string[];organizationIds:string[];snapshot:string;onCreated:()=>void};
/** A mode change must discard private document state synchronously, before its fetch completes. */
export default function DossierEditor(props:DossierEditorProps){return <DossierSession key={props.mode} {...props}/>;}
function DossierSession({mode,territoryId,signalIds,organizationIds,snapshot,onCreated}:DossierEditorProps) {
  const [items, setItems] = useState<Dossier[]>([]),
    [current, setCurrent] = useState<Dossier | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const refresh = () =>
    fetch(`/api/dossiers?mode=${mode}`)
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setError("Не удалось прочитать досье."));
  useEffect(() => {
    refresh();
  }, [mode]);
  const hasSelection=signalIds.length>0||(mode==="work"&&organizationIds.length>0);
  async function create() {
    if(!hasSelection)return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/dossiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          territoryId,
          signalIds,
          organizationIds,
          snapshot,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const missingOrganizations=organizationIds.filter(id=>!Array.isArray(d.organizationIds)||!d.organizationIds.includes(id));
      if(missingOrganizations.length)throw new Error("Не удалось добавить выбранных клиентов. Обновите список и повторите.");
      const missingSignals=signalIds.filter(id=>!Array.isArray(d.signalIds)||!d.signalIds.includes(id));
      if(missingSignals.length)throw new Error(`Не удалось добавить ${missingSignals.length} выбранных сигналов. Обновите ленту и повторите.`);
      setCurrent(d);
      onCreated();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/dossiers/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          title: current.title,
          questions: current.questions,
          actions: current.actions,
          notes: current.notes,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setCurrent(d);
      setSaved(true);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (current)
    return (
      <>
        <Back
          onClick={() => {
            setCurrent(null);
            setSaved(false);
          }}
        >
          Все досье
        </Back>
        <div className="editor-heading">
          <span className="eyebrow">
            {mode === "work" ? "Внутреннее досье" : "Публичное досье"}
          </span>
          <label>
            Название
            <input
              value={current.title}
              onChange={(e) => {
                setCurrent({ ...current, title: e.target.value });
                setSaved(false);
              }}
            />
          </label>
        </div>
        {(["goal", "participants"] as const).map(key=>(
          <label className="field" key={key}>
            {key==="goal"?"Цель встречи":"Участники"}
            <textarea rows={key==="goal"?3:4} value={meetingBrief(current.notes)[key]}
              placeholder={key==="goal"?"Что нужно решить на встрече":"Имя, организация, роль на встрече"}
              onChange={event=>{setCurrent({...current,notes:briefNotes({...meetingBrief(current.notes),[key]:event.target.value})});setSaved(false);}}/>
          </label>
        ))}
        <section className="document-section">
          <h3>Основание встречи · факты из источников</h3>
          <ul>
            {current.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
        {current.hypotheses.length>0&&<section className="document-section">
          <h3>Гипотезы для обсуждения</h3>
          <ul>
            {current.hypotheses.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>}
        {(["questions", "actions", "notes"] as const).map((key, i) => (
          <label className="field" key={key}>
            {["Повестка и вопросы", "Ожидаемый результат и следующие шаги", "Заметки по встрече"][i]}
            <textarea
              rows={key === "notes" ? 4 : 7}
              value={key==="notes"?meetingBrief(current.notes).notes:current[key]}
              onChange={(e) => {
                setCurrent({ ...current, [key]: key==="notes"?briefNotes({...meetingBrief(current.notes),notes:e.target.value}):e.target.value });
                setSaved(false);
              }}
            />
          </label>
        ))}
        <section className="document-section">
        <h3>Источники</h3>
        <div className="source-list">
          {current.sources.map((s, i) => (
            <Source key={i} url={s.url}>
              {s.label}
            </Source>
          ))}
        </div>
        </section>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="editor-actions">
          <button className="primary" onClick={save} disabled={busy}>
            {saved ? <Check size={16} /> : <Save size={16} />}{" "}
            {saved ? "Сохранено" : "Сохранить"}
          </button>
          <a
            className="secondary"
            target="_blank"
            href={`/dossier/${current.id}?mode=${mode}`}
            rel="noreferrer"
          >
            <Printer size={16} />
            Печать / PDF
          </a>
        </div>
        <p className="caption">
          Перед печатью сохраните изменения. Досье остаётся на этом компьютере.
        </p>
      </>
    );
  return (
    <>
      <p className="muted">
        Выберите клиентов и сигналы, которые хотите обсудить. Досье соберёт
        факты, источники и повестку; цель, участников и результат можно уточнить.
      </p>
      <div className="selection-summary">
        <strong>{signalIds.length}</strong> сигналов <span>·</span>
        <strong>{mode==="work"?organizationIds.length:0}</strong> клиентов
      </div>
      <button className="primary full" disabled={busy||!hasSelection} onClick={create}>
        <Plus size={17} />
        {busy ? "Собираем досье…" : "Создать досье встречи"}
      </button>
      {!hasSelection && (
        <Empty><FileText size={28}/><p>Выберите клиента или сигнал для встречи</p>
          <small>Добавьте материалы из карточки клиента или сигнала, затем вернитесь сюда.</small>
        </Empty>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3 className="section-title">
        Сохранённые досье <span>{items.length}</span>
      </h3>
      {!items.length ? (
        <Empty>
          <FileText size={28} />
          <p>Здесь появятся ваши встречи</p>
        </Empty>
      ) : (
        items.map((d) => (
          <button className="list-row" key={d.id} onClick={() => setCurrent(d)}>
            <FileText size={20} />
            <span>
              <strong>{d.title}</strong>
              <small>
                {shortDate(d.updatedAt)} · {d.facts.length} фактов
              </small>
            </span>
          </button>
        ))
      )}
    </>
  );
}
