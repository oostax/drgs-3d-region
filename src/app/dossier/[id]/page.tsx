import { getDossier } from "@/lib/dossiers";
import { parseDossierBrief } from "@/lib/dossier-brief";
import { modeOf } from "@/lib/types";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import PrintButton from "@/components/PrintButton";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { id } = await params;
  const mode = modeOf((await searchParams).mode);
  const host = (await headers()).get("host") || "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) notFound();
  const d = getDossier(id, mode);
  if (!d) notFound();
  const brief=parseDossierBrief(d.notes);
  return (
    <main className="print-document">
      <div className="print-top">
        <a href={`/?mode=${mode}`}>Сбер Атлас</a>
        <PrintButton />
      </div>
      <p className="eyebrow">
        {d.mode === "work"
          ? "Внутренние данные · локальное досье"
          : "Публичное досье"}
      </p>
      <h1>{d.title}</h1>
      <p>
        {new Date(d.updatedAt).toLocaleDateString("ru-RU")} · {d.territoryName}
      </p>
      {[["Цель встречи",brief.goal],["Участники",brief.participants]].map(([label,value])=>value&&(
        <section key={label}><h2>{label}</h2><p className="pre-wrap">{value}</p></section>
      ))}
      {[
        ["Основание встречи · факты из источников", d.facts],
        ["Гипотезы для обсуждения", d.hypotheses],
      ].map(([title, arr]) => (arr as string[]).length>0&&(
        <section key={String(title)}>
          <h2>{title}</h2>
          <ul>
            {(arr as string[]).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ))}
      {[
        ["Повестка и вопросы", d.questions],
        ["Ожидаемый результат и следующие шаги", d.actions],
        ["Заметки по встрече", brief.notes],
      ].map(
        ([label, value]) =>
          value && (
            <section key={label}>
              <h2>{label}</h2>
              <p className="pre-wrap">{value}</p>
            </section>
          ),
      )}
      <section>
        <h2>Источники</h2>
        {d.sources.map((s, i) => (
          <p key={i}>
            {s.label}
            {s.url && (
              <>
                {" "}
                — <a href={s.url}>{s.url}</a>
              </>
            )}
          </p>
        ))}
      </section>
      <footer>
        Сбер Атлас · Факты из выбранных источников. Гипотезы требуют проверки на
        встрече.
      </footer>
    </main>
  );
}
