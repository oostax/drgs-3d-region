"use client";
import { useEffect, useState } from "react";
import { number, shortDate } from "@/lib/format";
import { Empty } from "./ui";
type Row = {
  id: string;
  municipality: string;
  settlement: string | null;
  street: string | null;
  object: string | null;
  topic_group: string;
  topic: string;
  created_at: string | null;
  status: string;
};
export default function IncidentRecords({
  territoryId,
}: {
  territoryId: string;
}) {
  const [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [rows, setRows] = useState<Row[]>([]),
    [total, setTotal] = useState(0),
    [unknown, setUnknown] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    const t = setTimeout(
      () =>
        fetch(
          `/api/incidents?mode=work&territory=${territoryId}&q=${encodeURIComponent(q)}&offset=${offset}`,
          { signal: c.signal },
        )
          .then((r) => r.json())
          .then((d) => {
            setRows(d.items);
            setTotal(d.total);
            setUnknown(d.unlocated);
          })
          .catch((e) => {
            if (e.name !== "AbortError")
              setError("Не удалось прочитать обращения");
          })
          .finally(() => setLoading(false)),
      180,
    );
    return () => {
      c.abort();
      clearTimeout(t);
    };
  }, [q, offset, territoryId]);
  return (
    <>
      <p className="notice">
        Историческая выгрузка за июль 2026. Поля адреса сохранены как в
        источнике; наличие текста адреса не означает подтверждённые координаты.
      </p>
      <label className="field">
        Поиск по теме и адресу
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          placeholder="Например, дороги или улица"
        />
      </label>
      <p className="caption">
        {number(total)} записей · {number(unknown)} без сопоставленного
        муниципалитета
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">Загружаем…</p>
      ) : rows.length ? (
        rows.map((r) => (
          <div className="source-card" key={r.id}>
            <h3>{r.topic || r.topic_group}</h3>
            <p className="muted">{r.municipality}</p>
            <p className="caption">
              {[r.settlement, r.street, r.object].filter(Boolean).join(", ") ||
                "Подробный адрес не указан"}
            </p>
            <span className="tag neutral">
              {r.status || "Статус не указан"}
            </span>
            <p className="caption">
              {shortDate(r.created_at)} · координаты не подтверждены
            </p>
          </div>
        ))
      ) : (
        <Empty>Нет записей по этому запросу</Empty>
      )}
      <div className="pagination">
        <button
          className="secondary"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Назад
        </button>
        <span>
          {Math.min(offset + 1, total)}–{Math.min(offset + 50, total)} из{" "}
          {number(total)}
        </span>
        <button
          className="secondary"
          disabled={offset + 50 >= total}
          onClick={() => setOffset(offset + 50)}
        >
          Далее
        </button>
      </div>
    </>
  );
}
