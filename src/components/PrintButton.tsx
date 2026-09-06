"use client";
export default function PrintButton() {
  return (
    <button className="primary" onClick={() => window.print()}>
      Печать / сохранить PDF
    </button>
  );
}
