import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type Position = {id: string; after: boolean};
type Move = {pointerId: number; from: string; x: number; y: number; active: boolean; target: Position | null; timer: number};

export function useRowReorder(enabled: boolean, move: (id: string, target: Position) => void) {
  const pending = useRef<Move | null>(null);
  const dismissClick = useRef<string | null>(null);
  const latest = useRef(move);
  latest.current = move;
  const [drag, setDrag] = useState<{from: string; target: Position | null} | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let scroller = 0;
    const locate = (entry: Move) => {
      // Clamp the pointer horizontally to the table so dragging works from any cell.
      const table = document.querySelector<HTMLElement>('.table-scroller');
      if (!table) return;
      const bounds = table.getBoundingClientRect();
      const x = Math.max(bounds.left + 2, Math.min(bounds.right - 2, entry.x));
      const row = document.elementFromPoint(x, entry.y)?.closest<HTMLElement>('tr[data-row]');
      if (row?.dataset.row) {
        const bounds = row.getBoundingClientRect();
        entry.target = {id: row.dataset.row, after: entry.y >= bounds.top + bounds.height / 2};
      } else {
        entry.target = null;
      }
      setDrag(current => current?.from === entry.from && current.target?.id === entry.target?.id
        && current.target?.after === entry.target?.after ? current : {from: entry.from, target: entry.target});
    };
    const scroll = () => {
      const entry = pending.current;
      if (!entry?.active) return;
      const limit = 48;
      if (entry.y < limit) window.scrollBy(0, -9);
      if (entry.y > innerHeight - limit) window.scrollBy(0, 9);
      locate(entry);
      scroller = requestAnimationFrame(scroll);
    };
    const cancel = () => {
      if (pending.current) window.clearTimeout(pending.current.timer);
      pending.current = null;
      cancelAnimationFrame(scroller);
      scroller = 0;
      setDrag(null);
    };
    const track = (event: PointerEvent) => {
      const entry = pending.current;
      if (!entry || entry.pointerId !== event.pointerId) return;
      if (!entry.active && Math.hypot(entry.x - event.clientX, entry.y - event.clientY) > 9) {
        cancel();
        return;
      }
      if (entry.active) {
        event.preventDefault();
        if (!scroller) scroller = requestAnimationFrame(scroll);
      }
      entry.x = event.clientX;
      entry.y = event.clientY;
    };
    const finish = (event: PointerEvent) => {
      const entry = pending.current;
      if (!entry || entry.pointerId !== event.pointerId) return;
      if (entry.active) {
        entry.x = event.clientX;
        entry.y = event.clientY;
        locate(entry);
        dismissClick.current = entry.from;
        // The click from this pointer gesture is dispatched after pointerup.
        window.setTimeout(() => { if (dismissClick.current === entry.from) dismissClick.current = null; }, 150);
        if (entry.target && entry.target.id !== entry.from) latest.current(entry.from, entry.target);
      }
      cancel();
      scroller = 0;
    };
    window.addEventListener('pointermove', track, {passive: false});
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [enabled]);

  function hold(event: ReactPointerEvent, id: string) {
    if (!enabled || event.button !== 0 || !event.isPrimary || pending.current
      || (event.target as Element).closest('input, .detail-col')) return;
    const entry: Move = {pointerId: event.pointerId, from: id, x: event.clientX, y: event.clientY, active: false,
      target: null, timer: 0};
    entry.timer = window.setTimeout(() => {
      if (pending.current !== entry) return;
      entry.active = true;
      window.getSelection()?.removeAllRanges();
      setDrag({from: id, target: null});
    }, 300);
    pending.current = entry;
  }
  return {hold, drag, blocksClick: (id: string) => dismissClick.current === id};
}
