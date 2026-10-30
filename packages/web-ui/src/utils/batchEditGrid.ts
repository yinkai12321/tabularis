/**
 * Model and commit planning for the batch edit modal ("Batch edit…" on a grid
 * selection).
 *
 * The modal edits many rows and columns at once, but it never writes to the
 * database itself: it produces a {@link BatchCommitPlan} of cell writes that the
 * grid stages through its normal pending-change path. That keeps undo, the
 * generated/masked/physical-column guards and the "write the original value
 * back to clear a pending change" rule in exactly one place.
 */

import {isBlobWireFormat} from './blob';

/** How a cell input is rendered and parsed in the batch editor. */
export type BatchCellKind =
    'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'time' | 'enum' | 'json' | 'readonly';

/** One row of the batch editor. */
export interface BatchEditRow {
    /** Identity in the grid: `rowIndex` into the grid's merged rows. */
    rowIndex: number;
    type: 'existing' | 'insertion';
    /** Display number (1-based) shown in the row header. */
    displayNumber: number;
    /** Current values, aligned with {@link BatchEditModel.columns}. */
    values: unknown[];
    /** Values as staged/loaded, used to tell a real edit from a no-op. */
    originalValues: unknown[];
}

export interface BatchEditColumn {
    /** Index into the grid's `columns` array. */
    colIndex: number;
    name: string;
    dataType: string;
    isPk: boolean;
    isNullable: boolean;
    /** Generated columns are computed by the database and never accept a value. */
    isGenerated: boolean;
    /** Auto-increment columns stay editable but are flagged in the header. */
    isAutoIncrement: boolean;
    kind: BatchCellKind;
    /** Enum/set members when `kind` is `'enum'`. */
    enumValues?: string[];
    /** Why the column cannot be edited, when it cannot. */
    readonlyReason?: 'generated' | 'masked' | 'notPhysical' | 'blob';
}

export interface BatchEditModel {
    columns: BatchEditColumn[];
    rows: BatchEditRow[];
    /** True when at least one existing row can be written (needs a primary key). */
    canEditExisting: boolean;
}

/** A single staged write, addressed back to the grid's coordinate space. */
export interface BatchCellWrite {
    rowIndex: number;
    colIndex: number;
    value: unknown;
}

export interface BatchCommitPlan {
    /** Writes to stage; empty when nothing changed. */
    writes: BatchCellWrite[];
    /** Rows whose value differs from the original, for the "N modified" footer. */
    dirtyRowCount: number;
}

export interface BatchEditColumnInput {
    /** Index into the grid's `columns` array; kept so writes map back correctly. */
    colIndex: number;
    name: string;
    dataType: string;
    isPk: boolean;
    isNullable: boolean;
    isGenerated: boolean;
    isAutoIncrement: boolean;
}

export interface BuildBatchEditModelInput {
    columns: BatchEditColumnInput[];
    /**
     * Grid rows to include, already restricted to the selection. `values` is
     * aligned with the FIRST column's grid index, i.e. with `columns` order:
     * `values[i]` belongs to `columns[i]`.
     */
    rows: Array<{rowIndex: number; type: 'existing' | 'insertion'; values: unknown[]}>;
    /** Primary-key column names (case-insensitive), null when the grid has none. */
    pkColumns: string[] | null;
    /** Lowercased column names that are real table columns; null = no metadata. */
    physicalColumnSet: Set<string> | null;
    /** Lowercased names of masked columns. */
    maskedColumnSet: Set<string>;
    /** True when writes to existing rows are possible at all. */
    canEditExisting: boolean;
}

const NUMERIC_TYPE_PATTERN =
    /^(?:(?:tiny|small|medium|big)?int(?:eger)?|serial|bigserial|smallserial|decimal|numeric|real|double|float|money|number)/;

/** Types spanning several words (`timestamp with time zone`) match by prefix. */
const DATETIME_TYPE_PREFIXES = ['timestamp', 'datetime', 'smalldatetime'];
const TIME_TYPE_PREFIXES = ['time'];
const BLOB_TYPE_PATTERN = /bytea|blob|binary|varbinary|^image$|raw\b/;

const BOOLEAN_TYPES = new Set(['bool', 'boolean', 'bit']);
const JSON_TYPES = new Set(['json', 'jsonb']);

const normalizeType = (dataType: string) =>
    dataType.trim().toLowerCase().replace(/\(.*$/, '').replace(/\s+/g, ' ').trim();

/** Whether a declared SQL type stores binary data. */
export function isBatchBlobType(dataType: string): boolean {
    return BLOB_TYPE_PATTERN.test(normalizeType(dataType));
}

/**
 * Classifies a column into the input kind the batch editor renders. Unknown
 * types fall back to plain text so an exotic type is still editable.
 */
export function resolveBatchCellKind(
    dataType: string,
    options: {isEnum?: boolean; isBlob?: boolean} = {},
): BatchCellKind {
    const normalized = normalizeType(dataType);
    if (options.isBlob || BLOB_TYPE_PATTERN.test(normalized)) return 'readonly';
    if (options.isEnum) return 'enum';
    if (JSON_TYPES.has(normalized)) return 'json';
    if (BOOLEAN_TYPES.has(normalized)) return 'boolean';
    if (normalized === 'date') return 'date';
    if (DATETIME_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'datetime';
    if (TIME_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'time';
    if (NUMERIC_TYPE_PATTERN.test(normalized)) return 'number';
    return 'text';
}

/**
 * Builds the modal's model: which columns can be edited, in what kind of input,
 * and the current value of every cell in the selection.
 */
export function buildBatchEditModel(input: BuildBatchEditModelInput): BatchEditModel {
    const {columns, rows, pkColumns, physicalColumnSet, maskedColumnSet, canEditExisting} = input;

    const columnsOut: BatchEditColumn[] = columns.map((col) => {
        const lower = col.name.toLowerCase();
        const isBlob = isBatchBlobType(col.dataType);
        const kind = resolveBatchCellKind(col.dataType);
        let readonlyReason: BatchEditColumn['readonlyReason'];
        if (col.isGenerated) readonlyReason = 'generated';
        else if (isBlob) readonlyReason = 'blob';
        else if (maskedColumnSet.has(lower)) readonlyReason = 'masked';
        else if (physicalColumnSet && !physicalColumnSet.has(lower)) readonlyReason = 'notPhysical';

        return {
            colIndex: col.colIndex,
            name: col.name,
            dataType: col.dataType,
            isPk: col.isPk,
            isNullable: col.isNullable,
            isGenerated: col.isGenerated,
            isAutoIncrement: col.isAutoIncrement,
            kind: readonlyReason ? 'readonly' : kind,
            readonlyReason,
        };
    });

    const rowsOut: BatchEditRow[] = rows.map((row, index) => ({
        rowIndex: row.rowIndex,
        type: row.type,
        displayNumber: index + 1,
        values: row.values.slice(),
        originalValues: row.values.slice(),
    }));

    return {
        columns: columnsOut,
        rows: rowsOut,
        canEditExisting: canEditExisting && !!pkColumns && pkColumns.length > 0,
    };
}

/** True when a column accepts a staged write in the batch editor. */
export function isBatchColumnEditable(column: BatchEditColumn): boolean {
    return column.readonlyReason === undefined;
}

/**
 * Whether the row can receive writes at all: insertion rows always can
 * (they are staged forward only), existing rows need a primary key.
 */
export function isBatchRowEditable(row: BatchEditRow, model: BatchEditModel): boolean {
    return row.type === 'insertion' || model.canEditExisting;
}

/** The value a cell currently shows, honoring any staged edit. */
export function batchCellValue(row: BatchEditRow, position: number): unknown {
    return row.values[position];
}

/**
 * Applies one parsed edit to a row's value array, returning a new array.
 * Passing `undefined` clears the cell back to its original value, matching the
 * grid's "write the original back to clear a pending change" convention.
 */
export function setBatchCellValue(
    row: BatchEditRow,
    position: number,
    value: unknown,
): BatchEditRow {
    const next = row.values.slice();
    next[position] = value;
    return {...row, values: next};
}

const isEmptyValue = (value: unknown) => value === undefined;
const isStructured = (value: unknown) => typeof value === 'object' && value !== null;

/**
 * Compares two cell values the way the grid does: loose for scalars (so `1` and
 * `"1"` count as unchanged after a round-trip through a text input), strict for
 * structured values, and `null`/`undefined` collapse to a single "empty".
 */
export function isBatchCellUnchanged(value: unknown, original: unknown): boolean {
    if (isEmptyValue(value) && isEmptyValue(original)) return true;
    if (value === null && original === undefined) return true;
    if (original === null && value === undefined) return true;
    if (isStructured(value) || isStructured(original)) return Object.is(value, original);
    return String(value) === String(original);
}

/**
 * Turns the edited rows into a write plan. Only cells that actually changed are
 * written, so re-opening the modal and closing it stages nothing.
 */
export function planBatchCommit(model: BatchEditModel): BatchCommitPlan {
    const writes: BatchCellWrite[] = [];
    let dirtyRowCount = 0;

    for (const row of model.rows) {
        let rowDirty = false;
        model.columns.forEach((column, position) => {
            if (!isBatchColumnEditable(column)) return;
            const value = row.values[position];
            const original = row.originalValues[position];
            if (isBatchCellUnchanged(value, original)) return;
            rowDirty = true;
            writes.push({rowIndex: row.rowIndex, colIndex: column.colIndex, value});
        });
        if (rowDirty) dirtyRowCount++;
    }

    return {writes, dirtyRowCount};
}

/** Count of cells that differ from their original value. */
export function countBatchDirtyCells(model: BatchEditModel): number {
    let count = 0;
    for (const row of model.rows) {
        model.columns.forEach((column, position) => {
            if (!isBatchColumnEditable(column)) return;
            if (!isBatchCellUnchanged(row.values[position], row.originalValues[position])) {
                count++;
            }
        });
    }
    return count;
}

/** Restores every cell of a row to its original value. */
export function revertBatchRow(row: BatchEditRow): BatchEditRow {
    return {...row, values: row.originalValues.slice()};
}

/** Restores every cell of every row to its original value. */
export function revertBatchModel(model: BatchEditModel): BatchEditModel {
    return {...model, rows: model.rows.map(revertBatchRow)};
}

/**
 * Parses the raw text of a cell input into the value the grid stages.
 *
 * - `null` (the NULL button) stays `null`
 * - an empty text input on a nullable column is `null`; on a NOT NULL column it
 *   is the empty string, because that is what the user typed
 * - numbers become JS numbers when they parse cleanly, and keep the raw text
 *   otherwise so the database gets a chance to reject it with its own message
 * - booleans accept the editor's `true`/`false` strings
 */
export function parseBatchCellInput(
    raw: string,
    column: BatchEditColumn,
    options: {isNull?: boolean} = {},
): unknown {
    if (options.isNull) return null;
    if (column.kind === 'number') {
        const trimmed = raw.trim();
        if (trimmed === '') return column.isNullable ? null : raw;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : raw;
    }
    if (column.kind === 'boolean') {
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return raw;
    }
    if (raw === '' && column.isNullable) return null;
    return raw;
}

/** Renders a stored cell value into the text its input shows. */
export function formatBatchCellInput(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') {
        if (isBlobWireFormat(value)) return '<binary>';
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/**
 * Clamps a coordinate to the model's bounds so arrow-key navigation can never
 * move focus outside the table.
 */
export function clampBatchCell(
    model: BatchEditModel,
    rowIndex: number,
    colIndex: number,
): {rowIndex: number; colIndex: number} {
    const maxRow = Math.max(0, model.rows.length - 1);
    const maxCol = Math.max(0, model.columns.length - 1);
    return {
        rowIndex: Math.min(Math.max(0, rowIndex), maxRow),
        colIndex: Math.min(Math.max(0, colIndex), maxCol),
    };
}
