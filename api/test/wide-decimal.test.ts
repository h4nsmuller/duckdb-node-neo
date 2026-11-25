import { assert, beforeAll, describe, test } from 'vitest';
import {
  DECIMAL,
  DuckDBDataChunk,
  DuckDBDecimalBigNumVector,
  DuckDBDecimalType,
  DuckDBDecimalValue,
  DuckDBScalarFunction,
  DuckDBTypeId,
  DuckDBVariantValue,
  INTEGER,
  LIST,
  STRUCT,
  VARIANT,
  decimalValue,
  jsToDuckDBValue,
  listValue,
  structValue,
  variantValue,
} from '../src';
import {
  scaledValueFromDecimalString,
  scaledValueFromDouble,
} from '../src/conversion/wideDecimal';
import { setDefaultTimezone, withConnection } from './util/testHelpers';

// Wide decimals are DECIMAL types with more than 38 digits. DuckDB stores
// their unscaled value as a BIGNUM.

/** A decimal literal with `width` digits, `scale` of them fractional. */
function wideText(width: number, scale: number, negative = false): string {
  const digits = '1234567890'.repeat(width / 10 + 1).slice(0, width);
  const whole = digits.slice(0, width - scale) || '0';
  const text = scale > 0 ? `${whole}.${digits.slice(width - scale)}` : whole;
  return negative ? `-${text}` : text;
}

/** The DuckDBDecimalValue matching `wideText`. */
function wideValue(
  width: number,
  scale: number,
  negative = false
): DuckDBDecimalValue {
  const digits = '1234567890'.repeat(width / 10 + 1).slice(0, width);
  const value = BigInt(digits);
  return decimalValue(negative ? -value : value, width, scale);
}

const shapes = [
  { width: 39, scale: 0 },
  { width: 39, scale: 2 },
  { width: 39, scale: 39 },
  { width: 76, scale: 10 },
  { width: 255, scale: 0 },
  { width: 255, scale: 100 },
  { width: 255, scale: 255 },
];

describe('wide decimals', () => {
  beforeAll(setDefaultTimezone);

  test('read', async () => {
    await withConnection(async (connection) => {
      for (const { width, scale } of shapes) {
        for (const negative of [false, true]) {
          const text = wideText(width, scale, negative);
          const result = await connection.run(
            `select '${text}'::DECIMAL(${width},${scale}) as d, NULL::DECIMAL(${width},${scale}) as n`
          );
          const type = result.columnType(0);
          assert.instanceOf(type, DuckDBDecimalType);
          assert.deepEqual(type, DECIMAL(width, scale));
          const chunk = await result.fetchChunk();
          assert.isDefined(chunk);
          const vector = chunk!.getColumnVector(0);
          assert.instanceOf(vector, DuckDBDecimalBigNumVector);
          const expected = wideValue(width, scale, negative);
          assert.deepEqual(chunk!.getColumnValues(0), [expected]);
          assert.deepEqual(chunk!.getColumnValues(1), [null]);
          assert.strictEqual(
            (vector as DuckDBDecimalBigNumVector).getScaledValue(0),
            expected.value
          );
          assert.strictEqual(expected.toString(), text);
        }
      }
    });
  });

  test('zero and small values', async () => {
    await withConnection(async (connection) => {
      const reader = await connection.runAndReadAll(
        `select d::DECIMAL(50,3) as d from (values (0), (1), (-1), (0.001), (-0.001), (NULL)) t(d)`
      );
      assert.deepEqual(reader.getColumns()[0], [
        decimalValue(0n, 50, 3),
        decimalValue(1000n, 50, 3),
        decimalValue(-1000n, 50, 3),
        decimalValue(1n, 50, 3),
        decimalValue(-1n, 50, 3),
        null,
      ]);
    });
  });

  test('default session arithmetic', async () => {
    await withConnection(async (connection) => {
      // Adding two DECIMAL(38,2) values yields a DECIMAL(39,2).
      const reader = await connection.runAndReadAll(`
        select a + b as s from (select
          999999999999999999999999999999999999.99::DECIMAL(38,2) as a,
          999999999999999999999999999999999999.99::DECIMAL(38,2) as b)`);
      assert.deepEqual(reader.columnTypes(), [DECIMAL(39, 2)]);
      const value = reader.getRows()[0][0] as DuckDBDecimalValue;
      assert.deepEqual(
        value,
        decimalValue(199999999999999999999999999999999999998n, 39, 2)
      );
      assert.strictEqual(
        value.toString(),
        '1999999999999999999999999999999999999.98'
      );
    });
  });

  test('many rows, across chunks', async () => {
    await withConnection(async (connection) => {
      const reader = await connection.runAndReadAll(`
        select (i::DECIMAL(60,0) * 100000000000000000000000000000000000000 - 5)::DECIMAL(60,5) as d
        from range(5000) t(i)`);
      const values = reader.getColumns()[0] as DuckDBDecimalValue[];
      assert.strictEqual(values.length, 5000);
      for (let i = 0; i < values.length; i++) {
        const expected = (BigInt(i) * 10n ** 38n - 5n) * 100000n;
        assert.strictEqual(values[i].value, expected, `row ${i}`);
      }
    });
  });

  test('nested', async () => {
    await withConnection(async (connection) => {
      const pos = wideText(76, 10);
      const neg = wideText(76, 10, true);
      const reader = await connection.runAndReadAll(`
        select
          ['${pos}', NULL, '${neg}']::DECIMAL(76,10)[] as l,
          {'a': '${pos}'::DECIMAL(76,10), 'b': NULL::DECIMAL(76,10), 'c': ['${neg}'::DECIMAL(76,10)]} as s`);
      assert.deepEqual(reader.columnTypes(), [
        LIST(DECIMAL(76, 10)),
        STRUCT({
          a: DECIMAL(76, 10),
          b: DECIMAL(76, 10),
          c: LIST(DECIMAL(76, 10)),
        }),
      ]);
      assert.deepEqual(reader.getRows()[0], [
        listValue([wideValue(76, 10), null, wideValue(76, 10, true)]),
        structValue({
          a: wideValue(76, 10),
          b: null,
          c: listValue([wideValue(76, 10, true)]),
        }),
      ]);
    });
  });

  test('converted results never round to a double', async () => {
    await withConnection(async (connection) => {
      const text = wideText(76, 10, true);
      const reader = await connection.runAndReadAll(
        `select '${text}'::DECIMAL(76,10) as wide, [1.5::DECIMAL(50,1)] as nested, 1.5::DECIMAL(38,1) as narrow`
      );
      assert.deepEqual(reader.getRowsJson(), [[text, ['1.5'], '1.5']]);
      // The JS form of a DECIMAL of up to 38 digits is a number, as before.
      // A wider one is its exact decimal string.
      assert.deepEqual(reader.getRowsJS(), [[text, ['1.5'], 1.5]]);
      // The exact string is accepted back.
      assert.deepEqual(
        jsToDuckDBValue(text, DECIMAL(76, 10)),
        wideValue(76, 10, true)
      );
    });
  });

  test('explicit double conversions', () => {
    assert.strictEqual(wideValue(39, 2).toDouble(), 1.2345678901234568e36);
    assert.strictEqual(decimalValue(-15n, 50, 1).toDouble(), -1.5);
    assert.deepEqual(decimalValue(1.5, 50, 2), decimalValue(150n, 50, 2));
    assert.deepEqual(decimalValue(-0.125, 60, 2), decimalValue(-13n, 60, 2));
    // 1e40 as a double is exactly 10000000000000000303786028427003666890752.
    assert.strictEqual(
      scaledValueFromDouble(1e40, 50, 1),
      100000000000000003037860284270036668907520n
    );
    assert.throws(() => scaledValueFromDouble(1e40, 40, 0), /out of range/);
    assert.throws(() => scaledValueFromDouble(NaN, 40, 0), /Cannot convert/);
    assert.strictEqual(scaledValueFromDecimalString('-0.5', 3), -500n);
    assert.strictEqual(scaledValueFromDecimalString('.5', 1), 5n);
    assert.strictEqual(scaledValueFromDecimalString('12', 2), 1200n);
    assert.throws(() => scaledValueFromDecimalString('1.234', 2), /fractional/);
    assert.throws(() => scaledValueFromDecimalString('1e5', 2), /Malformed/);
  });

  test('bind', async () => {
    await withConnection(async (connection) => {
      const prepared = await connection.prepare(
        'select typeof($1) as t, $1 as v'
      );
      const values = [
        // Fit 128 bits.
        decimalValue(-12345n, 39, 2),
        decimalValue(0n, 76, 10),
        decimalValue(2n ** 126n, 255, 100),
        decimalValue(-(2n ** 127n), 255, 0),
        // Exceed 128 bits.
        decimalValue(2n ** 127n, 39, 0),
        ...shapes
          .filter(({ width }) => width > 39)
          .flatMap(({ width, scale }) => [
            wideValue(width, scale),
            wideValue(width, scale, true),
          ]),
      ];
      for (const value of values) {
        const type = `DECIMAL(${value.width},${value.scale})`;
        prepared.bindDecimal(1, value);
        let reader = await prepared.runAndReadAll();
        assert.deepEqual(reader.getRows(), [[type, value]], type);
        prepared.bindValue(1, value);
        reader = await prepared.runAndReadAll();
        assert.deepEqual(reader.getRows(), [[type, value]], type);
        prepared.bind([value]);
        reader = await prepared.runAndReadAll();
        assert.deepEqual(reader.getRows(), [[type, value]], type);
      }

      // Nested.
      const list = listValue([wideValue(76, 10), null, wideValue(76, 10, true)]);
      prepared.bindList(1, list, LIST(DECIMAL(76, 10)));
      const reader = await prepared.runAndReadAll();
      assert.deepEqual(reader.getRows(), [['DECIMAL(76,10)[]', list]]);

      // More digits than the width.
      assert.throws(
        () => prepared.bindDecimal(1, decimalValue(10n ** 59n, 59, 0)),
        /more digits than the width of 59/
      );
    });
  });

  test('appender', async () => {
    await withConnection(async (connection) => {
      await connection.run(`create table target(
        id INTEGER,
        d39 DECIMAL(39,2),
        d76 DECIMAL(76,10),
        d255 DECIMAL(255,100),
        l DECIMAL(76,10)[],
        s STRUCT(v DECIMAL(39,2))
      )`);
      const rows = [
        [wideValue(39, 2), wideValue(76, 10), wideValue(255, 100)],
        [
          wideValue(39, 2, true),
          wideValue(76, 10, true),
          wideValue(255, 100, true),
        ],
        [null, null, null],
        [
          decimalValue(0n, 39, 2),
          decimalValue(-1n, 76, 10),
          decimalValue(255n, 255, 100),
        ],
      ];
      const expected = rows.map(([d39, d76, d255], id) => [
        id,
        d39,
        d76,
        d255,
        listValue([d76, null]),
        structValue({ v: d39 }),
      ]);

      // Row by row.
      const appender = await connection.createAppender('target');
      for (const [id, d39, d76, d255, l, s] of expected) {
        appender.appendInteger(id as number);
        for (const d of [d39, d76, d255] as (DuckDBDecimalValue | null)[]) {
          if (d) {
            appender.appendDecimal(d);
          } else {
            appender.appendNull();
          }
        }
        appender.appendValue(l, LIST(DECIMAL(76, 10)));
        appender.appendValue(s, STRUCT({ v: DECIMAL(39, 2) }));
        appender.endRow();
      }
      appender.flushSync();
      let reader = await connection.runAndReadAll('from target order by id');
      assert.deepEqual(reader.getRows(), expected);

      // As a data chunk.
      await connection.run('delete from target');
      const chunk = DuckDBDataChunk.create([
        INTEGER,
        DECIMAL(39, 2),
        DECIMAL(76, 10),
        DECIMAL(255, 100),
        LIST(DECIMAL(76, 10)),
        STRUCT({ v: DECIMAL(39, 2) }),
      ]);
      chunk.setRows(expected);
      appender.appendDataChunk(chunk);
      appender.flushSync();
      appender.closeSync();
      reader = await connection.runAndReadAll('from target order by id');
      assert.deepEqual(reader.getRows(), expected);

      // DuckDB reads back the same text.
      reader = await connection.runAndReadAll(
        'select d255::VARCHAR from target where id = 1'
      );
      assert.deepEqual(reader.getRows(), [[wideText(255, 100, true)]]);

      // More digits than the width.
      assert.throws(
        () => chunk.setColumnValues(1, rows.map(() => wideValue(40, 2))),
        /more digits than the width of 39/
      );
    });
  });

  test('scalar function', async () => {
    await withConnection(async (connection) => {
      connection.registerScalarFunction(
        DuckDBScalarFunction.create({
          name: 'wide_negate',
          parameterTypes: [DECIMAL(76, 10)],
          returnType: DECIMAL(76, 10),
          mainFunction: (_info, input, output) => {
            const values = input.getColumnValues(0) as DuckDBDecimalValue[];
            for (let rowIndex = 0; rowIndex < input.rowCount; rowIndex++) {
              const { value, width, scale } = values[rowIndex];
              output.setItem(rowIndex, decimalValue(-value, width, scale));
            }
            output.flush();
          },
        })
      );
      const reader = await connection.runAndReadAll(
        `select wide_negate('${wideText(76, 10)}'::DECIMAL(76,10)) as d`
      );
      assert.deepEqual(reader.columnTypes(), [DECIMAL(76, 10)]);
      assert.deepEqual(reader.getRows(), [[wideValue(76, 10, true)]]);
    });
  });

  test('variant', async () => {
    await withConnection(async (connection) => {
      const text = wideText(76, 10, true);
      const expected = variantValue(wideValue(76, 10, true), DECIMAL(76, 10));
      let reader = await connection.runAndReadAll(
        `select '${text}'::DECIMAL(76,10)::VARIANT as v`
      );
      assert.deepEqual(reader.getRows(), [[expected]]);

      // Written as a VARIANT, DuckDB reads the same DECIMAL back.
      await connection.run('create table target(v VARIANT)');
      const appender = await connection.createAppender('target');
      const chunk = DuckDBDataChunk.create([VARIANT]);
      chunk.setRows([[expected]]);
      appender.appendDataChunk(chunk);
      appender.closeSync();
      reader = await connection.runAndReadAll(
        'select v, variant_typeof(v), v::VARCHAR from target'
      );
      const row = reader.getRows()[0];
      assert.instanceOf(row[0], DuckDBVariantValue);
      assert.deepEqual(row, [expected, 'DECIMAL(76, 10)', text]);
    });
  });

  // The C API reports the width and scale of a DECIMAL as uint8, and 0 for
  // a wider type, so such a column has no usable type.
  test('wider than the C API can describe', async () => {
    await withConnection(async (connection) => {
      const text = wideText(300, 2, true);
      const pattern = /DECIMAL types wider than 255 digits are not supported/;
      for (const sql of [
        `select '${text}'::DECIMAL(300,2) as d`,
        `select ['${text}'::DECIMAL(300,2)] as d`,
        `select NULL::DECIMAL(256,0) as d`,
      ]) {
        const result = await connection.run(sql);
        assert.strictEqual(result.columnTypeId(0) !== DuckDBTypeId.INVALID, true);
        assert.throws(() => result.columnType(0), pattern);
        const chunk = await result.fetchChunk();
        assert.isDefined(chunk);
        assert.throws(() => chunk!.getColumnValues(0), pattern);
        const reader = await connection.runAndReadAll(sql);
        assert.throws(() => reader.getRows(), pattern);
        assert.throws(() => reader.getRowsJson(), pattern);
      }
      assert.throws(() => DECIMAL(256, 0).toLogicalType(), /width/);

      // The exact value is available as text, and a 255-digit parameter is
      // exact in the wider type.
      const prepared = await connection.prepare(
        'select $1::DECIMAL(300,2)::VARCHAR as v'
      );
      prepared.bindDecimal(1, wideValue(255, 2, true));
      const reader = await prepared.runAndReadAll();
      assert.deepEqual(reader.getRows(), [[wideText(255, 2, true)]]);
    });
  });
});
