"use client";
import { X, ArrowUpRight, ChevronLeft } from "lucide-react";
import { useEffect, useRef } from "react";
export function IconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className || ""}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
export function Source({
  url,
  children,
}: {
  url?: string | null;
  children: React.ReactNode;
}) {
  return url ? (
    <a className="source-link" href={url} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : (
    <span className="source-link">{children}</span>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <IconButton label="Закрыть" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <div className="modal-content">{children}</div>
    </dialog>
  );
}
export function Back({
  onClick,
  children = "Назад",
}: {
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button className="text-button back" onClick={onClick}>
      <ChevronLeft size={16} />
      {children}
    </button>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
