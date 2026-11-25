import duckdb, { Decimal } from '@duckdb/node-bindings';
import { stringFromDecimal } from '../conversion/stringFromDecimal';
import {
  decimalFitsHugeInt,
  MAX_NARROW_DECIMAL_WIDTH,
  scaledValueFromDouble,
} from '../conversion/wideDecimal';

export class DuckDBDecimalValue implements Decimal {
  /** Total number of decimal digits (including fractional digits) in represented number. */
  public readonly width: number;

  /** Number of fractional digits in represented number. */
  public readonly scale: number;

  /** Scaled-up value. Represented number is value/(10^scale). */
  public readonly value: bigint;

  /**
   * @param value Scaled-up value. Represented number is value/(10^scale).
   * @param width Total number of decimal digits (including fractional digits) in represented number.
   * @param scale Number of fractional digits in represented number.
   */
  public constructor(value: bigint, width: number, scale: number) {
    this.width = width;
    this.scale = scale;
    this.value = value;
  }

  public toString(): string {
    return stringFromDecimal(this.value, this.scale);
  }

  /**
   * The nearest double. This is the only place a DECIMAL becomes a double,
   * and only on request: results never convert a DECIMAL implicitly.
   */
  public toDouble(): number {
    if (
      this.width > MAX_NARROW_DECIMAL_WIDTH ||
      !decimalFitsHugeInt(this.value)
    ) {
      // duckdb_decimal_to_double takes a 128-bit value.
      return Number(this.toString());
    }
    return duckdb.decimal_to_double(this);
  }

  public static fromDouble(double: number, width: number, scale: number): DuckDBDecimalValue {
    if (width > MAX_NARROW_DECIMAL_WIDTH) {
      // duckdb_double_to_decimal returns a 128-bit value.
      return new DuckDBDecimalValue(
        scaledValueFromDouble(double, width, scale),
        width,
        scale
      );
    }
    const decimal = duckdb.double_to_decimal(double, width, scale);
    return new DuckDBDecimalValue(decimal.value, decimal.width, decimal.scale);
  }
}

export function decimalValue(value: bigint | number, width: number, scale: number): DuckDBDecimalValue {
  if (typeof value === 'number') {
    return DuckDBDecimalValue.fromDouble(value, width, scale);
  }
  return new DuckDBDecimalValue(value, width, scale);
}
