import {describe, expect, it} from 'vitest';
import {
    buildBatchEditModel,
    clampBatchCell,
    countBatchDirtyCells,
    formatBatchCellInput,
    isBatchCellUnchanged,
    isBatchColumnEditable,
    isBatchRowEditable,
    parseBatchCellInput,
    planBatchCommit,
    resolveBatchCellKind,
    revertBatchModel,
    revertBatchRow,
    setBatchCellValue,
    type BatchEditColumnInput,
    type BuildBatchEditModelInput,
} from '../../src/utils/batchEditGrid';

let nextColIndex = 0;
const col = (over: Partial<BatchEditColumnInput> = {}): BatchEditColumnInput => ({
    colIndex: over.colIndex ?? nextColIndex++,
    name: 'name',
    dataType: 'text',
    isPk: false,
    isNullable: true,
    isGenerated: false,
    isAutoIncrement: false,
    ...over,
});

const build = (over: Partial<BuildBatchEditModelInput> = {}) =>
    buildBatchEditModel({
        columns: [
            col({colIndex: 0, name: 'id', dataType: 'integer', isPk: true, isNullable: false}),
            col({colIndex: 1, name: 'name', dataType: 'text'}),
        ],
        rows: [
            {rowIndex: 3, type: 'existing', values: [1, 'alice']},
            {rowIndex: 7, type: 'existing', values: [2, 'bob']},
        ],
        pkColumns: ['id'],
        physicalColumnSet: new Set(['id', 'name']),
        maskedColumnSet: new Set(),
        canEditExisting: true,
        ...over,
    });

describe('resolveBatchCellKind', () => {
    it('classifies common scalar types', () => {
        expect(resolveBatchCellKind('integer')).toBe('number');
        expect(resolveBatchCellKind('bigint')).toBe('number');
        expect(resolveBatchCellKind('numeric(10,2)')).toBe('number');
        expect(resolveBatchCellKind('double precision')).toBe('number');
        expect(resolveBatchCellKind('text')).toBe('text');
        expect(resolveBatchCellKind('varchar(255)')).toBe('text');
        expect(resolveBatchCellKind('boolean')).toBe('boolean');
        expect(resolveBatchCellKind('bit')).toBe('boolean');
        expect(resolveBatchCellKind('date')).toBe('date');
        expect(resolveBatchCellKind('timestamp with time zone')).toBe('datetime');
        expect(resolveBatchCellKind('datetime2')).toBe('datetime');
        expect(resolveBatchCellKind('time')).toBe('time');
        expect(resolveBatchCellKind('jsonb')).toBe('json');
    });

    it('treats blobs as readonly and enums as enum', () => {
        expect(resolveBatchCellKind('bytea', {isBlob: true})).toBe('readonly');
        expect(resolveBatchCellKind('bytea')).toBe('readonly');
        expect(resolveBatchCellKind('varchar', {isEnum: true})).toBe('enum');
    });

    it('falls back to text for unknown types', () => {
        expect(resolveBatchCellKind('geometry')).toBe('text');
        expect(resolveBatchCellKind('weird_custom_type')).toBe('text');
    });
});

describe('buildBatchEditModel', () => {
    it('builds columns and rows from the selection', () => {
        const model = build();
        expect(model.columns.map((c) => c.name)).toEqual(['id', 'name']);
        expect(model.rows).toHaveLength(2);
        expect(model.rows[0].displayNumber).toBe(1);
        expect(model.rows[1].displayNumber).toBe(2);
        expect(model.rows[0].values).toEqual([1, 'alice']);
        expect(model.canEditExisting).toBe(true);
    });

    it('marks generated columns readonly', () => {
        const model = build({
            columns: [col({name: 'name'}), col({name: 'slug', isGenerated: true})],
        });
        expect(model.columns[1].readonlyReason).toBe('generated');
        expect(model.columns[1].kind).toBe('readonly');
    });

    it('marks masked columns readonly', () => {
        const model = build({maskedColumnSet: new Set(['name'])});
        expect(model.columns[1].readonlyReason).toBe('masked');
    });

    it('marks columns missing from the physical table readonly', () => {
        const model = build({
            columns: [col({name: 'id'}), col({name: 'alias_col'})],
            physicalColumnSet: new Set(['id']),
        });
        expect(model.columns[1].readonlyReason).toBe('notPhysical');
    });

    it('disables existing-row editing without a primary key', () => {
        const model = build({pkColumns: null});
        expect(model.canEditExisting).toBe(false);
        expect(isBatchRowEditable(model.rows[0], model)).toBe(false);
    });

    it('keeps insertion rows editable without a primary key', () => {
        const model = build({
            pkColumns: null,
            rows: [{rowIndex: 0, type: 'insertion', values: [null, 'new']}],
        });
        expect(isBatchRowEditable(model.rows[0], model)).toBe(true);
    });

    it('does not mutate the input values', () => {
        const values = [1, 'alice'];
        const model = build({rows: [{rowIndex: 0, type: 'existing', values}]});
        model.rows[0].values[1] = 'changed';
        expect(values[1]).toBe('alice');
    });
});

describe('isBatchCellUnchanged', () => {
    it('compares scalars loosely, as a text round-trip would', () => {
        expect(isBatchCellUnchanged('1', 1)).toBe(true);
        expect(isBatchCellUnchanged(1, '1')).toBe(true);
        expect(isBatchCellUnchanged('alice', 'Alice')).toBe(false);
    });

    it('collapses null and undefined', () => {
        expect(isBatchCellUnchanged(null, undefined)).toBe(true);
        expect(isBatchCellUnchanged(undefined, null)).toBe(true);
        expect(isBatchCellUnchanged(null, '')).toBe(false);
    });

    it('compares structured values strictly', () => {
        expect(isBatchCellUnchanged({a: 1}, {a: 1})).toBe(false);
        const shared = {a: 1};
        expect(isBatchCellUnchanged(shared, shared)).toBe(true);
    });
});

describe('planBatchCommit', () => {
    it('stages nothing when nothing changed', () => {
        const model = build();
        expect(planBatchCommit(model)).toEqual({writes: [], dirtyRowCount: 0});
    });

    it('stages only the changed cells', () => {
        const model = build();
        model.rows[1] = setBatchCellValue(model.rows[1], 1, 'robert');
        const plan = planBatchCommit(model);
        expect(plan.writes).toEqual([{rowIndex: 7, colIndex: 1, value: 'robert'}]);
        expect(plan.dirtyRowCount).toBe(1);
    });

    it('stages writes across several rows and columns', () => {
        let model = build();
        model = {...model, rows: model.rows.map((r) => setBatchCellValue(r, 1, 'x'))};
        const plan = planBatchCommit(model);
        expect(plan.writes).toHaveLength(2);
        expect(plan.dirtyRowCount).toBe(2);
        expect(plan.writes.map((w) => w.rowIndex)).toEqual([3, 7]);
    });

    it('never stages writes for readonly columns', () => {
        let model = build({
            columns: [col({name: 'id'}), col({name: 'slug', isGenerated: true})],
        });
        model.rows[0] = setBatchCellValue(model.rows[0], 1, 'new-slug');
        expect(planBatchCommit(model).writes).toEqual([]);
    });

    it('stages a null write for a cleared cell', () => {
        let model = build();
        model.rows[0] = setBatchCellValue(model.rows[0], 1, null);
        expect(planBatchCommit(model).writes).toEqual([{rowIndex: 3, colIndex: 1, value: null}]);
    });

    it('counts dirty cells without building the plan', () => {
        let model = build();
        model.rows[0] = setBatchCellValue(model.rows[0], 1, 'a');
        model.rows[1] = setBatchCellValue(model.rows[1], 1, 'b');
        expect(countBatchDirtyCells(model)).toBe(2);
    });
});

describe('revert helpers', () => {
    it('restores a single row', () => {
        let model = build();
        model.rows[0] = setBatchCellValue(model.rows[0], 1, 'changed');
        const reverted = revertBatchRow(model.rows[0]);
        expect(reverted.values).toEqual([1, 'alice']);
    });

    it('restores the whole model', () => {
        let model = build();
        model.rows = model.rows.map((r) => setBatchCellValue(r, 1, 'changed'));
        expect(countBatchDirtyCells(revertBatchModel(model))).toBe(0);
    });
});

describe('parseBatchCellInput', () => {
    const nullableNumberCol = build({
        columns: [col({name: 'amount', dataType: 'numeric'})],
        physicalColumnSet: new Set(['amount']),
    }).columns[0];
    const textCol = build().columns[1];

    it('parses numbers and keeps unparseable text', () => {
        expect(parseBatchCellInput('42', nullableNumberCol)).toBe(42);
        expect(parseBatchCellInput('4.5', nullableNumberCol)).toBe(4.5);
        expect(parseBatchCellInput(' 7 ', nullableNumberCol)).toBe(7);
        expect(parseBatchCellInput('abc', nullableNumberCol)).toBe('abc');
    });

    it('maps an empty numeric cell to null only when nullable', () => {
        expect(parseBatchCellInput('', nullableNumberCol)).toBe(null);
        const notNull = {...nullableNumberCol, isNullable: false};
        // Empty numeric input on a NOT NULL column keeps what was typed, so the
        // database rejects it with its own message instead of us inventing a 0.
        expect(parseBatchCellInput('', notNull)).toBe('');
    });

    it('maps an empty text cell to null only when nullable', () => {
        expect(parseBatchCellInput('', textCol)).toBe(null);
        const notNull = {...textCol, isNullable: false};
        expect(parseBatchCellInput('', notNull)).toBe('');
    });

    it('parses booleans', () => {
        const boolCol = {...textCol, kind: 'boolean' as const};
        expect(parseBatchCellInput('true', boolCol)).toBe(true);
        expect(parseBatchCellInput('false', boolCol)).toBe(false);
        expect(parseBatchCellInput('TRUE', boolCol)).toBe('TRUE');
    });

    it('honors the explicit NULL option', () => {
        expect(parseBatchCellInput('ignored', textCol, {isNull: true})).toBe(null);
        const notNull = {...textCol, isNullable: false};
        expect(parseBatchCellInput('ignored', notNull, {isNull: true})).toBe(null);
    });
});

describe('formatBatchCellInput', () => {
    it('renders primitives', () => {
        expect(formatBatchCellInput(null)).toBe('');
        expect(formatBatchCellInput(undefined)).toBe('');
        expect(formatBatchCellInput(42)).toBe('42');
        expect(formatBatchCellInput(true)).toBe('true');
        expect(formatBatchCellInput(false)).toBe('false');
        expect(formatBatchCellInput('text')).toBe('text');
    });

    it('renders structured values as JSON', () => {
        expect(formatBatchCellInput({a: 1})).toBe('{"a":1}');
    });
});

describe('clampBatchCell', () => {
    it('keeps coordinates inside the table', () => {
        const model = build();
        expect(clampBatchCell(model, -5, -5)).toEqual({rowIndex: 0, colIndex: 0});
        expect(clampBatchCell(model, 99, 99)).toEqual({rowIndex: 1, colIndex: 1});
        expect(clampBatchCell(model, 1, 0)).toEqual({rowIndex: 1, colIndex: 0});
    });

    it('handles a model with no rows', () => {
        const model = build({rows: []});
        expect(clampBatchCell(model, 3, 3)).toEqual({rowIndex: 0, colIndex: 1});
    });
});

describe('isBatchColumnEditable', () => {
    it('reflects the readonly reason', () => {
        const model = build({maskedColumnSet: new Set(['name'])});
        expect(isBatchColumnEditable(model.columns[0])).toBe(true);
        expect(isBatchColumnEditable(model.columns[1])).toBe(false);
    });
});
