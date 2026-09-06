"use client";
import { useEffect, useRef, useState } from "react";
import { Sun, Moon, Sunrise, Sunset, Clock3 } from "lucide-react";
import { getSceneTime, type SceneAppearance } from "@/lib/solar";

const phaseNames = {
  night: "Ночь",
  dawn: "Рассвет",
  morning: "Утро",
  day: "День",
  sunset: "Закат",
  twilight: "Сумерки",
};
export default function SceneClock({
  appearance,
  onChange,
}: {
  appearance: SceneAppearance;
  onChange: (value: SceneAppearance) => void;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        detailsRef.current &&
        !detailsRef.current.contains(event.target as Node)
      )
        detailsRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailsRef.current)
        detailsRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const scene = now ? getSceneTime(appearance, { date: now }) : null;
  const hour = scene?.localHour ?? appearance.hour;
  const time =
    String(Math.floor(hour) % 24).padStart(2, "0") +
    ":" +
    String(Math.floor((hour % 1) * 60)).padStart(2, "0");
  const PhaseIcon =
    scene?.phase === "night"
      ? Moon
      : scene?.phase === "dawn"
        ? Sunrise
        : scene?.phase === "sunset" || scene?.phase === "twilight"
          ? Sunset
          : Sun;
  return (
    <details ref={detailsRef} className="scene-clock">
      <summary aria-label="Время и жизнь города">
        <PhaseIcon size={17} />
        <span suppressHydrationWarning>{now ? time : "—:—"}</span>
        <span className="clock-zone">МСК</span>
      </summary>
      <div className="time-popover glass">
        <div className="time-heading">
          <div>
            <strong>{time}</strong>
            <span>
              {scene ? phaseNames[scene.phase] : "Местное время"} · UTC+3
            </span>
          </div>
          <PhaseIcon size={30} />
        </div>
        <button
          className={`secondary full ${appearance.timeMode === "auto" ? "selected" : ""}`}
          onClick={() => onChange({ ...appearance, timeMode: "auto" })}
        >
          <Clock3 size={16} />
          {appearance.timeMode === "auto"
            ? "Сейчас · местное время"
            : "Вернуться к текущему времени"}
        </button>
        <label className="field">
          Время на карте · МСК
          <input
            aria-label="Час суток"
            type="range"
            min="0"
            max="23.75"
            step="0.25"
            value={hour}
            onChange={(e) =>
              onChange({
                ...appearance,
                timeMode: "manual",
                hour: Number(e.target.value),
              })
            }
          />
        </label>
        <div className="hour-presets">
          {[0, 6, 12, 18].map((h) => (
            <button
              key={h}
              onClick={() =>
                onChange({ ...appearance, timeMode: "manual", hour: h })
              }
            >
              {String(h).padStart(2, "0")}:00
            </button>
          ))}
        </div>
        <p className="caption">
          Рассвет и закат следуют солнцу по всей России. Время указано по Москве.
          Движение транспорта и техники —
          симуляция, а не данные наблюдения.
        </p>
      </div>
    </details>
  );
}
