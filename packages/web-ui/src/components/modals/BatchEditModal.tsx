import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useVirtualizer} from '@tanstack/react-virtual';
import {CornerDownLeft, RotateCcw, Table2, X} from 'lucide-react';
import clsx from 'clsx';
import {Modal} from '@/components/ui/Modal';
import {BatchEditCell} from '@/components/ui/BatchEditCell';
import {
    clampBatchCell,
    countBatchDirtyCells,
    isBatchColumnEditable,
    isBatchRowEditable,
    planBatchCommit,
    revertBatchModel,
    revertBatchRow,
    setBatchCellValue,
    type BatchCellWrite,
    type BatchEditModel,
} from '@/utils/batchEditGrid';

interface BatchEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    model: BatchEditModel | null;
    /** Stages the changed cells; the grid owns the pending-change and undo path. */
    onApply: (writes: BatchCellWrite[]) => void;
    /** Marks rows for deletion (existing rows only). */
    onDeleteRows?: (rowIndices: number[]) => void;
}

const ROW_HEIGHT = 30;
const ROW_HEADER_WIDTH = 56;

/**
 * Spreadsheet-style batch editor over a grid selection, opened from the grid's
 * context menu or its shortcut. Edits stay local to the modal until "Apply",
 * which hands a list of changed cells to the grid so they are staged like any
 * other edit (undo, pending highlight and commit all follow the grid's rules).
 */
export const BatchEditModal = ({
    isOpen,
    onClose,
    model: initialModel,
    onApply,
    onDeleteRows,
}: BatchEditModalProps) => {
    const {t} = useTranslation();
    const [model, setModel] = useState<BatchEditModel | null>(initialModel);
    const [active, setActive] = useState<{rowIndex: number; position: number}>({
        rowIndex: 0,
        position: 0,
    });
    const scrollRef = useRef<HTMLDivElement>(null);

    // Reset the local copy whenever the modal opens on a new selection.
    useEffect(() => {
        if (isOpen) {
            setModel(initialModel);
            setActive({rowIndex: 0, position: 0});
        }
    }, [isOpen, initialModel]);

    const dirtyCells = model ? countBatchDirtyCells(model) : 0;

    // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes non-memoizable methods; this local usage does not pass them to memoized children.
    const rowVirtualizer = useVirtualizer({
        count: model?.rows.length ?? 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    const setCell = useCallback((rowIndex: number, position: number, value: unknown) => {
        setModel((current) => {
            if (!current) return current;
            const target = current.rows.findIndex((row) => row.rowIndex === rowIndex);
            if (target < 0) return current;
            const rows = current.rows.slice();
            rows[target] = setBatchCellValue(rows[target], position, value);
            return {...current, rows};
        });
    }, []);

    const handleRevertAll = useCallback(() => {
        setModel((current) => (current ? revertBatchModel(current) : current));
    }, []);

    const handleRevertRow = useCallback((rowIndex: number) => {
        setModel((current) => {
            if (!current) return current;
            const target = current.rows.findIndex((row) => row.rowIndex === rowIndex);
            if (target < 0) return current;
            const rows = current.rows.slice();
            rows[target] = revertBatchRow(rows[target]);
            return {...current, rows};
        });
    }, []);

    const handleApply = useCallback(() => {
        if (!model) return;
        const plan = planBatchCommit(model);
        if (plan.writes.length > 0) onApply(plan.writes);
        onClose();
    }, [model, onApply, onClose]);

    const rowPositions = useMemo(
        () => (model ? model.rows.map((row) => row.rowIndex) : []),
        [model],
    );

    // Active cell moves in (row position, column position) space and stores the
    // real row index, so a re-render after a revert keeps the same cell focused.
    const moveActive = useCallback(
        (deltaRow: number, deltaCol: number) => {
            if (!model) return;
            setActive((current) => {
                const currentRowPos = Math.max(0, rowPositions.indexOf(current.rowIndex));
                const next = clampBatchCell(
                    model,
                    currentRowPos + deltaRow,
                    current.position + deltaCol,
                );
                return {
                    rowIndex: model.rows[next.rowIndex]?.rowIndex ?? 0,
                    position: next.colIndex,
                };
            });
        },
        [model, rowPositions],
    );

    const handleCellKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            switch (event.key) {
                case 'ArrowDown':
                case 'Enter':
                    event.preventDefault();
                    moveActive(1, 0);
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    moveActive(-1, 0);
                    break;
                case 'Tab':
                    event.preventDefault();
                    moveActive(0, event.shiftKey ? -1 : 1);
                    break;
                default:
                    break;
            }
        },
        [moveActive],
    );

    const handleDeleteSelected = useCallback(() => {
        if (!model || !onDeleteRows) return;
        const existing = model.rows
            .filter((row) => row.type === 'existing')
            .map((row) => row.rowIndex);
        if (existing.length > 0) onDeleteRows(existing);
    }, [model, onDeleteRows]);

    if (!isOpen || !model) return null;

    const editableColumnCount = model.columns.filter(isBatchColumnEditable).length;
    const gridTemplate = `${ROW_HEADER_WIDTH}px repeat(${model.columns.length}, minmax(140px, 1fr))`;
    const canEditAnything = model.rows.some((row) => isBatchRowEditable(row, model));

    return (
        <Modal isOpen={isOpen} onClose={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="batch-edit-title"
                className="bg-elevated border border-strong rounded-xl shadow-2xl w-[90vw] max-w-[1400px] h-[85vh] flex flex-col overflow-hidden"
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-default bg-base">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-accent-secondary/15 rounded-lg">
                            <Table2 size={20} className="text-accent-secondary" />
                        </div>
                        <div>
                            <h2
                                id="batch-edit-title"
                                className="text-lg font-semibold text-primary"
                            >
                                {t('batchEdit.title')}
                            </h2>
                            <p className="text-xs text-secondary">
                                {t('batchEdit.subtitle', {
                                    rows: model.rows.length,
                                    columns: editableColumnCount,
                                })}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-secondary hover:text-primary transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X size={20} />
                    </button>
                </div>

                {!canEditAnything && (
                    <div className="px-4 py-2 text-xs text-accent-warning bg-accent-warning/10 border-b border-accent-warning/25">
                        {t('batchEdit.noKeyHint')}
                    </div>
                )}

                {/* Table */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <div
                        className="grid border-b border-strong bg-surface-secondary text-xs font-bold uppercase text-muted"
                        style={{gridTemplateColumns: gridTemplate}}
                    >
                        <div className="px-2 py-2" />
                        {model.columns.map((column) => (
                            <div
                                key={column.colIndex}
                                className="px-2 py-2 border-l border-default flex items-center gap-1.5 min-w-0"
                                title={`${column.dataType}${column.isPk ? ` · ${t('batchEdit.pk')}` : ''}`}
                            >
                                {column.isPk && (
                                    <span className="text-semantic-pk normal-case">PK</span>
                                )}
                                <span className="truncate text-primary">{column.name}</span>
                                <span className="truncate text-[10px] font-normal normal-case text-muted">
                                    {column.dataType}
                                </span>
                            </div>
                        ))}
                    </div>

                    <div ref={scrollRef} className="flex-1 overflow-auto">
                        <div
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                position: 'relative',
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const row = model.rows[virtualRow.index];
                                if (!row) return null;
                                const rowEditable = isBatchRowEditable(row, model);
                                const rowDirty = row.values.some(
                                    (value, position) =>
                                        !Object.is(value, row.originalValues[position]),
                                );
                                return (
                                    <div
                                        key={row.rowIndex}
                                        className={clsx(
                                            'grid absolute left-0 top-0 w-full',
                                            virtualRow.index % 2 === 1 && 'bg-surface-secondary/30',
                                        )}
                                        style={{
                                            gridTemplateColumns: gridTemplate,
                                            height: `${virtualRow.size}px`,
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        <div className="flex items-center justify-between gap-1 px-2 text-xs text-muted border-r border-default">
                                            <span className="tabular-nums">
                                                {row.displayNumber}
                                            </span>
                                            {row.type === 'insertion' && (
                                                <span className="text-accent-success">+</span>
                                            )}
                                            {rowDirty && (
                                                <button
                                                    onClick={() => handleRevertRow(row.rowIndex)}
                                                    className="text-muted hover:text-primary"
                                                    title={t('batchEdit.revertRow')}
                                                    aria-label={t('batchEdit.revertRow')}
                                                >
                                                    <RotateCcw size={11} />
                                                </button>
                                            )}
                                        </div>
                                        {model.columns.map((column, position) => {
                                            const isActive =
                                                active.rowIndex === row.rowIndex &&
                                                active.position === position;
                                            const dirty = !Object.is(
                                                row.values[position],
                                                row.originalValues[position],
                                            );
                                            return (
                                                <div
                                                    key={column.colIndex}
                                                    className={clsx(
                                                        'border-l border-default min-w-0',
                                                        dirty && 'bg-accent-warning/10',
                                                    )}
                                                >
                                                    <BatchEditCell
                                                        column={column}
                                                        value={row.values[position]}
                                                        dirty={dirty}
                                                        active={isActive}
                                                        rowReadonly={!rowEditable}
                                                        onFocus={() =>
                                                            setActive({
                                                                rowIndex: row.rowIndex,
                                                                position,
                                                            })
                                                        }
                                                        onChange={(value) =>
                                                            setCell(row.rowIndex, position, value)
                                                        }
                                                        onKeyDown={handleCellKeyDown}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-default bg-base/50 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-xs text-secondary">
                        <span>
                            {dirtyCells > 0
                                ? t('batchEdit.dirtyCount', {count: dirtyCells})
                                : t('batchEdit.noChanges')}
                        </span>
                        {dirtyCells > 0 && (
                            <button
                                onClick={handleRevertAll}
                                className="flex items-center gap-1 text-muted hover:text-primary transition-colors"
                            >
                                <RotateCcw size={12} />
                                {t('batchEdit.revertAll')}
                            </button>
                        )}
                        {onDeleteRows && (
                            <button
                                onClick={handleDeleteSelected}
                                className="flex items-center gap-1 text-muted hover:text-accent-error transition-colors"
                            >
                                {t('batchEdit.deleteRows', {count: model.rows.length})}
                            </button>
                        )}
                        <span className="flex items-center gap-1 text-muted">
                            <CornerDownLeft size={11} />
                            {t('batchEdit.keyboardHint')}
                        </span>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-secondary hover:text-primary transition-colors text-sm"
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleApply}
                            disabled={dirtyCells === 0}
                            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-inverse rounded-lg text-sm font-medium transition-colors"
                        >
                            {t('batchEdit.apply')}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
};
