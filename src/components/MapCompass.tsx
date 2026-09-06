'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { compassAngle, ringBearing, tiltCompass, wrapBearing, type CompassCamera, type CompassPose } from '../lib/map-compass';
import styles from './MapCompass.module.css';

const EMPTY: CompassPose = { bearing: 0, pitch: 0, maxPitch: 0 };
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5);
type Drag = { id: number; target: HTMLElement; kind: 'ring' | 'tilt'; x: number; y: number; cx: number; cy: number; angle: number | null; pose: CompassPose };
type Props = { camera: CompassCamera | null; open: boolean; onOpenChange: (open: boolean) => void; is3D: boolean; disabled?: boolean };

export default function MapCompass({ camera, open, onOpenChange, is3D, disabled = false }: Props) {
  const id = useId(), helpId = `${id}-help`;
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null), pending = useRef<CompassPose | null>(null), frame = useRef<number | null>(null);
  const [pose, setPose] = useState<CompassPose>(EMPTY);
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false });
  const [dragging, setDragging] = useState(false);
  const visible = open && !!camera && !disabled;
  const unavailable = !camera || disabled;

  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current; pending.current = null;
    if (next && camera) { camera.write(next); setPose(camera.read()); }
  }, [camera]);

  const finish = useCallback((commit = true) => {
    if (commit) flush();
    else { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; pending.current = null; }
    const current = drag.current; drag.current = null;
    if (current?.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
    camera?.end();
    setDragging(false);
  }, [camera, flush]);

  // Subscribe only this small control; no frame-rate state in the parent Atlas.
  useEffect(() => {
    if (!camera) { setPose(EMPTY); return; }
    let updateFrame: number | null = null;
    const update = () => {
      if (updateFrame !== null) return;
      updateFrame = requestAnimationFrame(() => {
        updateFrame = null;
        if (!drag.current) setPose(camera.read());
      });
    };
    setPose(camera.read());
    const unsubscribe = camera.subscribe(update);
    update();
    return () => { unsubscribe(); if (updateFrame !== null) cancelAnimationFrame(updateFrame); };
  }, [camera, is3D]);

  // Discard pending input if the mode, map, or active overlay changed mid-drag.
  useEffect(() => () => finish(false), [visible, is3D, finish]);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const button = trigger.current, popup = panel.current;
      if (!button || !popup) return;
      const anchor = button.getBoundingClientRect(), rect = popup.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12, top = (viewport?.offsetTop ?? 0) + 12;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const right = left + width - 24, bottom = top + height - 24;
      const x = anchor.right + 12 + rect.width <= right ? anchor.right + 12 : anchor.left - rect.width - 12;
      setPosition({ left: Math.max(left, Math.min(x, right - rect.width)), top: Math.max(top, Math.min(anchor.top + anchor.height / 2 - rect.height / 2, bottom - rect.height)), visible: true });
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    ring.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const close = () => { finish(false); onOpenChange(false); trigger.current?.focus({ preventScroll: true }); };
    const outside = (event: globalThis.PointerEvent) => {
      if (drag.current) return;
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) { finish(false); onOpenChange(false); }
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    };
    const cancel = () => finish(false);
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('pointerdown', outside, true);
    // Capture stops the Atlas-wide Escape handler from also clearing selection.
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden);
    };
  }, [visible, finish, onOpenChange]);

  const begin = (event: PointerEvent<HTMLDivElement>, kind: Drag['kind']) => {
    if (!camera || disabled || !event.isPrimary || event.button !== 0 || drag.current) return;
    const current = camera.read();
    if (kind === 'tilt' && current.maxPitch === 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    camera.begin();
    const rect = event.currentTarget.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    drag.current = { id: event.pointerId, target: event.currentTarget, kind, x: event.clientX, y: event.clientY, cx, cy,
      angle: compassAngle(event.clientX - cx, event.clientY - cy), pose: camera.read() };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || !camera) return;
    event.preventDefault(); event.stopPropagation();
    const maxPitch = camera.read().maxPitch;
    if (current.kind === 'ring') {
      const angle = compassAngle(event.clientX - current.cx, event.clientY - current.cy);
      if (angle !== null && current.angle !== null) current.pose.bearing = ringBearing(current.pose.bearing, current.angle, angle);
      current.angle = angle;
      current.pose.pitch = Math.min(current.pose.pitch, maxPitch);
    } else {
      current.pose = tiltCompass({ ...current.pose, maxPitch }, event.clientX - current.x, event.clientY - current.y);
    }
    current.x = event.clientX; current.y = event.clientY;
    pending.current = { ...current.pose, maxPitch };
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };
  const end = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (event.pointerId !== drag.current?.id) return;
    event.stopPropagation(); finish(commit);
  };
  const change = (next: Partial<CompassPose>) => {
    if (!camera || disabled) return;
    finish(false); camera.begin(); camera.write(next); camera.end(); setPose(camera.read());
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>, kind: Drag['kind']) => {
    if (!camera || disabled) return;
    const current = camera.read(), step = event.shiftKey ? 15 : 5;
    let next: Partial<CompassPose> | null = null;
    if (kind === 'ring') {
      if (['ArrowRight', 'ArrowUp'].includes(event.key)) next = { bearing: current.bearing + step };
      if (['ArrowLeft', 'ArrowDown'].includes(event.key)) next = { bearing: current.bearing - step };
      if (event.key === 'Home') next = { bearing: 0 };
      if (event.key === 'End') next = { bearing: 180 };
    } else if (current.maxPitch > 0) {
      if (event.key === 'ArrowUp') next = { pitch: current.pitch + step };
      if (event.key === 'ArrowDown') next = { pitch: current.pitch - step };
      if (event.key === 'ArrowLeft') next = { bearing: current.bearing - step };
      if (event.key === 'ArrowRight') next = { bearing: current.bearing + step };
      if (event.key === 'Home') next = { pitch: 0 };
      if (event.key === 'End') next = { pitch: current.maxPitch };
    }
    if (next) { event.preventDefault(); event.stopPropagation(); change(next); }
  };
  const heading = ((Math.round(wrapBearing(pose.bearing)) % 360) + 360) % 360;
  const close = () => { finish(false); onOpenChange(false); trigger.current?.focus({ preventScroll: true }); };
  return <div className={styles.control}>
    <button ref={trigger} type="button" className={`icon-button ${visible ? 'active' : ''}`} aria-label="3D-компас" title="3D-компас: направление и наклон"
      aria-expanded={visible} aria-controls={visible ? id : undefined} aria-haspopup="dialog" disabled={unavailable} onClick={() => onOpenChange(!visible)}>
      <svg width="20" height="20" viewBox="0 0 24 24" style={{ transform: `rotate(${-pose.bearing}deg)` }} aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M12 4 16 15 12 13 8 15Z" fill="currentColor"/><path d="m12 13 4 2-4 5-4-5Z" fill="currentColor" opacity=".35"/>
      </svg>
    </button>
    {visible && createPortal(<div ref={panel} id={id} role="dialog" aria-label="3D-компас" className={styles.panel}
      data-dragging={dragging} style={{ left: position.left, top: position.top, visibility: position.visible ? 'visible' : 'hidden' }}>
      <header className={styles.header}><div><strong>3D-компас</strong><span>Направление и наклон</span></div>
        <button type="button" aria-label="Закрыть компас" onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className={styles.instrument}>
        <span className={styles.index} aria-hidden="true" />
        <div ref={ring} className={styles.ring} role="slider" tabIndex={0} aria-label="Направление карты" aria-valuemin={0} aria-valuemax={360}
          aria-valuenow={heading} aria-valuetext={`Азимут ${heading} градусов`} aria-describedby={helpId} data-compass-ring=""
          onPointerDown={e => begin(e, 'ring')} onPointerMove={move} onPointerUp={e => end(e, true)} onPointerCancel={e => end(e, false)}
          onLostPointerCapture={e => end(e, false)} onKeyDown={e => keyboard(e, 'ring')} onDoubleClick={() => change({ bearing: 0 })}>
          <svg viewBox="0 0 216 216" aria-hidden="true" className={styles.rose}>
            <g transform={`rotate(${-pose.bearing},108,108)`}>
              {TICKS.map(angle => <line key={angle} x1="108" y1={angle % 30 === 0 ? 14 : 18} x2="108" y2="24"
                transform={`rotate(${angle},108,108)`} className={angle === 0 ? styles.north : undefined} />)}
              {[['С', 0], ['В', 90], ['Ю', 180], ['З', 270]].map(([text, angle]) => <text key={text} x="108" y="39"
                transform={`rotate(${angle},108,108)`} className={angle === 0 ? styles.north : undefined}>{text}</text>)}
            </g>
          </svg>
        </div>
        <div className={styles.tilt} role="slider" tabIndex={0} aria-label="Наклон камеры" aria-orientation="vertical" aria-valuemin={0}
          aria-valuemax={pose.maxPitch} aria-valuenow={Math.round(pose.pitch)} aria-valuetext={is3D ? `${Math.round(pose.pitch)} градусов` : 'Наклон доступен в режиме 3D'}
          aria-disabled={!is3D} aria-describedby={helpId} data-compass-tilt=""
          onPointerDown={e => begin(e, 'tilt')} onPointerMove={move} onPointerUp={e => end(e, true)} onPointerCancel={e => end(e, false)}
          onLostPointerCapture={e => end(e, false)} onKeyDown={e => keyboard(e, 'tilt')} onDoubleClick={() => change({ pitch: 0 })}>
          <div className={styles.plane} style={{ transform: `rotateX(${pose.pitch}deg) rotateZ(${-pose.bearing}deg)` }} aria-hidden="true">
            <svg viewBox="0 0 110 110"><path d="M55 15 69 65 55 58 41 65Z" className={styles.needle}/><path d="m55 58 14 7-14 30-14-30Z" className={styles.tail}/></svg>
          </div>
          <span className={styles.tiltLabel} aria-hidden="true">{is3D ? `${Math.round(pose.pitch)}°` : '2D'}</span>
        </div>
      </div>
      <div className={styles.readout} aria-hidden="true"><span>Азимут <b>{heading}°</b></span><span>Наклон <b>{Math.round(pose.pitch)}°</b></span></div>
      <p id={helpId} className={styles.help}>Кольцо — поворот. Центр — наклон.<br/>{is3D ? 'Двойной клик: север / вид сверху.' : 'Для наклона включите 3D на карте.'}<span className={styles.srOnly}> Стрелки меняют угол на 5 градусов, с Shift — на 15. Home сбрасывает угол.</span></p>
    </div>, document.body)}
  </div>;
}
