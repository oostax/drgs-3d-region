import type { Metadata } from "next";
import "./globals.css";
import "./map-first.css";
import "./live-map.css";
import "./signal-card.css";
import "maplibre-gl/dist/maplibre-gl.css";
export const metadata: Metadata = {
  title: "Сбер Атлас — Татарстан",
  description: "Территории, сигналы и подготовка встреч на 3D-карте Татарстана",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
