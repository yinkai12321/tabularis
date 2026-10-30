import React, {useCallback} from 'react';
import {Ban} from 'lucide-react';
import {useTranslation} from 'react-i18next';
import clsx from 'clsx';
import {
    formatBatchCellInput,
    parseBatchCellInput,
    type BatchEditColumn,
} from '@/utils/batchEditGrid';
import {DateInput} from './DateInput';
import {EnumSetInput} from './EnumSetInput';
import type {DateInputMode} from '@/utils/dateInput';

interface BatchEditCellProps {
    column: BatchEditColumn;
    value: unknown;
    /** True when the cell differs from its original value. */
    dirty: boolean;
    /** True when this cell holds keyboard focus. */
    active: boolean;
    /** Read-only because the whole row (existing row without a primary key) cannot be written. */
    rowReadonly?: boolean;
    onFocus: () => void;
    onChange: (value: unknown) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
}

const INPUT_CLASS =
    'w-full h-full px-2 py-1 bg-transparent text-primary text-sm focus:outline-none';

const dateModeForKind = (kind: BatchEditColumn['kind']): DateInputMode | null => {
    if (kind === 'date') return 'date';
    if (kind === 'datetime') return 'datetime';
    if (kind === 'time') return 'time';
    return null;
};

/**
 * One editable cell of the batch edit modal. Text-like kinds render a plain
 * input; dates reuse the grid's DateInput, enums the EnumSetInput dropdown, and
 * everything the modal cannot represent faithfully (generated columns, BLOBs,
 * masked values, aliases) renders as a locked cell that explains why.
 */
export const BatchEditCell = ({
    column,
    value,
    dirty,
    active,
    rowReadonly,
    onFocus,
    onChange,
    onKeyDown,
}: BatchEditCellProps) => {
    const {t} = useTranslation();
    const readonly = column.readonlyReason !== undefined || !!rowReadonly;

    const handleTextChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            onChange(parseBatchCellInput(event.target.value, column));
        },
        [column, onChange],
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            // Enter commits and moves down; Escape is handled by the modal.
            onKeyDown(event);
        },
        [onKeyDown],
    );

    if (readonly) {
        const reasonKey =
            column.readonlyReason === 'generated'
                ? 'batchEdit.readonlyGenerated'
                : column.readonlyReason === 'masked'
                  ? 'batchEdit.readonlyMasked'
                  : column.readonlyReason === 'blob'
                    ? 'batchEdit.readonlyBlob'
                    : column.readonlyReason === 'notPhysical'
                      ? 'batchEdit.readonlyNotPhysical'
                      : 'batchEdit.readonlyNoKey';
        return (
            <div
                className={clsx(
                    'flex h-full items-center gap-1.5 px-2 text-xs text-muted',
                    active && 'ring-1 ring-inset ring-focus',
                )}
                title={t(reasonKey)}
                aria-readonly="true"
            >
                <Ban size={11} className="shrink-0" />
                <span className="truncate font-mono">
                    {formatBatchCellInput(value) || t('batchEdit.emptyValue')}
                </span>
            </div>
        );
    }

    const dateMode = dateModeForKind(column.kind);
    if (dateMode) {
        return (
            <div className={clsx('h-full', active && 'ring-1 ring-inset ring-focus')}>
                <DateInput
                    value={formatBatchCellInput(value)}
                    mode={dateMode}
                    onChange={(next) => onChange(next === '' && column.isNullable ? null : next)}
                    onKeyDown={handleKeyDown}
                    className={INPUT_CLASS}
                />
            </div>
        );
    }

    if (column.kind === 'enum' && column.enumValues && column.enumValues.length > 0) {
        return (
            <div className={clsx('h-full', active && 'ring-1 ring-inset ring-focus')}>
                <EnumSetInput
                    value={value === null || value === undefined ? null : String(value)}
                    options={column.enumValues}
                    isNullable={column.isNullable}
                    variant="inline"
                    onChange={(next) => onChange(next)}
                />
            </div>
        );
    }

    if (column.kind === 'boolean') {
        return (
            <select
                value={formatBatchCellInput(value)}
                onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '' && column.isNullable) onChange(null);
                    else onChange(raw === 'true');
                }}
                onFocus={onFocus}
                onKeyDown={handleKeyDown}
                className={clsx(
                    'h-full w-full bg-transparent px-2 text-sm text-primary focus:outline-none',
                    dirty && 'text-accent-warning',
                )}
                aria-label={column.name}
            >
                {column.isNullable && <option value="">NULL</option>}
                <option value="true">{t('batchEdit.true')}</option>
                <option value="false">{t('batchEdit.false')}</option>
            </select>
        );
    }

    return (
        <input
            type={column.kind === 'number' ? 'text' : 'text'}
            inputMode={column.kind === 'number' ? 'decimal' : undefined}
            value={formatBatchCellInput(value)}
            onChange={handleTextChange}
            onFocus={onFocus}
            onKeyDown={handleKeyDown}
            placeholder={value === null ? t('batchEdit.nullValue') : undefined}
            aria-label={column.name}
            className={clsx(
                INPUT_CLASS,
                dirty && 'text-accent-warning',
                active && 'ring-1 ring-inset ring-focus',
                column.kind === 'number' && 'font-mono tabular-nums',
            )}
        />
    );
};
