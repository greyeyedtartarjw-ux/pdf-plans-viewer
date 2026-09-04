import React, { useState, useRef, useCallback } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { updateMeasurement } from '@workspace/api-client-react';
import { addPendingOp, nextPendingSequence } from '../lib/pendingQueue';
import { Trash2, Download, Ruler, Hexagon, ChevronDown, ChevronRight, GripVertical, Pencil, Check, X } from 'lucide-react';

interface MeasurementWithPage {
  id: string;
  type: string;
  label: string;
  valueLabel: string;
  realWorldValue: number;
  unit: string;
  pageNum: number;
  data: Record<string, unknown>;
}

// ─── Inline label editor ─────────────────────────────────────────────────────

interface InlineLabelEditorProps {
  id: string;
  pageNum: number;
  label: string;
  valueLabel: string; // e.g. "12.50 ft"
  measurement: MeasurementWithPage;
  documentId: number | null;
}

function InlineLabelEditor({ id, pageNum, label, valueLabel, measurement, documentId }: InlineLabelEditorProps) {
  const { dispatch } = useViewerContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(label);
    setEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== label) {
      dispatch({ type: 'RENAME_MEASUREMENT', page: pageNum, id, label: trimmed });
      if (documentId) {
        const payload = {
          label: trimmed,
          valueLabel,
          realWorldValue: measurement.realWorldValue,
          unit: measurement.unit,
          fabricData: measurement.data,
        };
        void updateMeasurement(documentId, id, payload).catch(() => {
          addPendingOp({
            opType: 'update_measurement',
            documentId,
            id,
            pageNumber: pageNum,
            ...payload,
            timestamp: Date.now(),
            sequence: nextPendingSequence(),
          });
        });
      }
    }
    setEditing(false);
  }, [draft, label, dispatch, pageNum, id, documentId, measurement, valueLabel]);

  const cancel = useCallback(() => {
    setDraft(label);
    setEditing(false);
  }, [label]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (editing) {
    return (
      <div
        className="flex items-center gap-1 flex-1 min-w-0"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 text-xs bg-background/40 border border-primary/60 rounded px-1.5 py-0.5 text-sidebar-foreground outline-none focus:border-primary"
          placeholder={valueLabel}
        />
        <button
          onMouseDown={e => { e.preventDefault(); commit(); }}
          className="p-0.5 text-primary hover:text-primary/80 shrink-0"
          title="Save"
        >
          <Check size={11} />
        </button>
        <button
          onMouseDown={e => { e.preventDefault(); cancel(); }}
          className="p-0.5 text-sidebar-foreground/50 hover:text-sidebar-foreground shrink-0"
          title="Cancel"
        >
          <X size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0 group/label">
      <span
        className="text-xs font-mono font-medium text-sidebar-foreground bg-background/20 px-1.5 py-0.5 rounded truncate max-w-[10rem] cursor-text hover:bg-background/40 transition-colors"
        title={label}
        onClick={startEdit}
      >
        {label}
      </span>
      <button
        onClick={startEdit}
        className="opacity-0 group-hover/label:opacity-100 p-0.5 text-sidebar-foreground/40 hover:text-primary transition-all shrink-0"
        title="Rename"
      >
        <Pencil size={10} />
      </button>
    </div>
  );
}

// ─── Draggable measurement item ───────────────────────────────────────────────

interface MeasurementItemProps {
  m: MeasurementWithPage;
  index: number;
  onDelete: (e: React.MouseEvent, page: number, id: string) => void;
  onNavigate: (page: number) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDragEnd: () => void;
  isDraggingOver: boolean;
  documentId: number | null;
}

function MeasurementItem({
  m, index, onDelete, onNavigate, onDragStart, onDragEnter, onDragEnd, isDraggingOver, documentId,
}: MeasurementItemProps) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(index)}
      onDragEnter={() => onDragEnter(index)}
      onDragEnd={onDragEnd}
      onDragOver={e => e.preventDefault()}
      onClick={() => onNavigate(m.pageNum)}
      className={`group flex flex-col bg-background/5 border rounded p-2.5 cursor-pointer transition-colors select-none ${
        isDraggingOver
          ? 'border-primary bg-primary/10'
          : 'border-sidebar-border hover:border-primary/50'
      }`}
    >
      <div className="flex justify-between items-start mb-1">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="opacity-0 group-hover:opacity-100 text-sidebar-foreground/30 cursor-grab active:cursor-grabbing shrink-0 transition-opacity"
            onClick={e => e.stopPropagation()}
          >
            <GripVertical size={12} />
          </span>
          <span className="text-xs font-medium text-primary">Page {m.pageNum}</span>
        </div>
        <button
          onClick={(e) => onDelete(e, m.pageNum, m.id)}
          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 hover:text-destructive rounded text-sidebar-foreground/50 transition-all shrink-0"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="flex justify-between items-end gap-2">
        <span className="text-xs text-sidebar-foreground/60 shrink-0">
          {m.type === 'area' ? 'Area' : 'Distance'}
        </span>
        <InlineLabelEditor
          id={m.id}
          pageNum={m.pageNum}
          label={m.label}
          valueLabel={m.valueLabel}
          measurement={m}
          documentId={documentId}
        />
      </div>
    </div>
  );
}

// ─── Section with collapsible + reorderable items ────────────────────────────

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  measurements: MeasurementWithPage[];
  subtotalLabel: string;
  onDelete: (e: React.MouseEvent, page: number, id: string) => void;
  onNavigate: (page: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  accentClass: string;
  documentId: number | null;
}

function MeasurementSection({
  title, icon, measurements, subtotalLabel, onDelete, onNavigate, onReorder, accentClass, documentId,
}: SectionProps) {
  const [expanded, setExpanded] = useState(true);
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const handleDragEnter = (index: number) => {
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    if (dragIndexRef.current !== null && dragOverIndex !== null && dragIndexRef.current !== dragOverIndex) {
      onReorder(dragIndexRef.current, dragOverIndex);
    }
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  if (measurements.length === 0) return null;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-white/5 transition-colors text-sidebar-foreground/80 group"
      >
        <span className="text-sidebar-foreground/50">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wider flex-1 text-left">{title}</span>
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full bg-background/20 ${accentClass}`}>
          {measurements.length}
        </span>
        <span className="text-xs font-mono text-sidebar-foreground/60">{subtotalLabel}</span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1.5 pl-2">
          {measurements.map((m, index) => (
            <MeasurementItem
              key={m.id}
              m={m}
              index={index}
              onDelete={onDelete}
              onNavigate={onNavigate}
              onDragStart={handleDragStart}
              onDragEnter={handleDragEnter}
              onDragEnd={handleDragEnd}
              isDraggingOver={dragOverIndex === index}
              documentId={documentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root component ──────────────────────────────────────────────────────────

export default function MeasurementIndex() {
  const { state, dispatch } = useViewerContext();
  const { measurements, measurementOrder, documentId } = state;

  // Flatten all measurements, preserving page association
  const allMeasurements: MeasurementWithPage[] = Object.entries(measurements).flatMap(([pageStr, ms]) =>
    ms.map(m => ({ ...m, pageNum: parseInt(pageStr) }))
  );

  // Sort by measurementOrder when available, fallback to natural order
  const ordered = measurementOrder.length > 0
    ? [...allMeasurements].sort((a, b) => {
        const ai = measurementOrder.indexOf(a.id);
        const bi = measurementOrder.indexOf(b.id);
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      })
    : allMeasurements;

  const distances = ordered.filter(m => m.type === 'distance');
  const areas = ordered.filter(m => m.type === 'area');

  const handleDelete = (e: React.MouseEvent, page: number, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_MEASUREMENT', page, id });
  };

  const handleNavigate = (page: number) => {
    dispatch({ type: 'SET_CURRENT_PAGE', page });
  };

  // Reorder within a typed section (distances or areas)
  const makeReorderHandler = (section: MeasurementWithPage[]) => (fromIndex: number, toIndex: number) => {
    // Build new section order
    const newSection = [...section];
    const [moved] = newSection.splice(fromIndex, 1);
    newSection.splice(toIndex, 0, moved);

    // Rebuild the full ordered list: keep non-section items in place, replace section items
    const nonSection = ordered.filter(m => m.type !== moved.type);
    const sectionIds = new Set(section.map(m => m.id));

    // Insert the reordered section back into the full order at the positions previously occupied
    const newOrdered = [...ordered];
    let sectionIdx = 0;
    for (let i = 0; i < newOrdered.length; i++) {
      if (sectionIds.has(newOrdered[i].id)) {
        newOrdered[i] = newSection[sectionIdx++];
      }
    }

    dispatch({ type: 'REORDER_MEASUREMENTS', orderedIds: newOrdered.map(m => m.id) });
  };

  const handleExportCSV = () => {
    if (ordered.length === 0) return;

    let csv = 'Page,Type,Label,Value,Unit\n';
    ordered.forEach(m => {
      csv += `${m.pageNum},${m.type},"${m.label}",${m.realWorldValue},${m.unit}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `measurements_export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const totalDistance = distances.reduce((acc, m) => acc + m.realWorldValue, 0);
  const totalArea = areas.reduce((acc, m) => acc + m.realWorldValue, 0);
  const unit = 'ft';

  if (ordered.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sidebar-foreground/50 text-sm gap-3 p-6 text-center">
        <div className="w-12 h-12 rounded-full border border-sidebar-border bg-background/5 flex items-center justify-center mb-2">
          <div className="w-6 h-px bg-sidebar-foreground/30" />
        </div>
        No measurements yet.
        <span className="text-xs">Use the toolbar to measure distances and areas.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-sidebar-border flex justify-between items-center bg-sidebar">
        <h3 className="text-sm font-semibold text-sidebar-foreground">Takeoffs</h3>
        <button
          onClick={handleExportCSV}
          className="p-1.5 text-sidebar-foreground hover:bg-white/10 hover:text-primary rounded transition-colors text-xs flex items-center gap-1"
          title="Export CSV"
        >
          <Download size={14} /> CSV
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 bg-sidebar">
        <MeasurementSection
          title="Distances"
          icon={<Ruler size={13} className="text-blue-400 shrink-0" />}
          measurements={distances}
          subtotalLabel={`${totalDistance.toFixed(2)} ${unit}`}
          onDelete={handleDelete}
          onNavigate={handleNavigate}
          onReorder={makeReorderHandler(distances)}
          accentClass="text-blue-400"
          documentId={documentId}
        />
        <MeasurementSection
          title="Areas"
          icon={<Hexagon size={13} className="text-violet-400 shrink-0" />}
          measurements={areas}
          subtotalLabel={`${totalArea.toFixed(2)} ${unit}²`}
          onDelete={handleDelete}
          onNavigate={handleNavigate}
          onReorder={makeReorderHandler(areas)}
          accentClass="text-violet-400"
          documentId={documentId}
        />
      </div>

      <div className="p-4 border-t border-sidebar-border bg-sidebar-border/30">
        <div className="text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wider mb-2">Grand Totals</div>
        <div className="space-y-1.5">
          {distances.length > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-sm text-sidebar-foreground/80">Distance</span>
              <span className="text-sm font-mono text-sidebar-foreground font-semibold">
                {totalDistance.toFixed(2)} {unit}
              </span>
            </div>
          )}
          {areas.length > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-sm text-sidebar-foreground/80">Area</span>
              <span className="text-sm font-mono text-sidebar-foreground font-semibold">
                {totalArea.toFixed(2)} {unit}²
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
