/**
 * Helpers for DECIMAL types wider than 38 digits ("wide decimals").
 *
 * DuckDB stores the unscaled value of a wide decimal as a BIGNUM, while the
 * `duckdb_decimal` struct of the C API carries a 128-bit value only. These
 * helpers decide which values need a route other than that struct, and keep
 * every conversion exact.
 */

/** The widest DECIMAL that is stored as an integer of up to 128 bits. */
export const MAX_NARROW_DECIMAL_WIDTH = 38;

/**
 * The widest DECIMAL the C API can describe: it reports and accepts the
 * width and scale of a DECIMAL type as a `uint8_t`.
 */
export const MAX_DECIMAL_WIDTH = 255;

const HUGEINT_MIN = -(2n ** 127n);
const HUGEINT_MAX = 2n ** 127n - 1n;

const powersOfTen: bigint[] = [];

export function powerOfTen(exponent: number): bigint {
  let power = powersOfTen[exponent];
  if (power === undefined) {
    power = 10n ** BigInt(exponent);
    powersOfTen[exponent] = power;
  }
  return power;
}

/** Whether a scaled DECIMAL value fits the 128 bits of a `duckdb_decimal`. */
export function decimalFitsHugeInt(scaledValue: bigint): boolean {
  return scaledValue >= HUGEINT_MIN && scaledValue <= HUGEINT_MAX;
}

/** Whether a scaled DECIMAL value has at most `width` digits. */
export function decimalFitsWidth(scaledValue: bigint, width: number): boolean {
  const limit = powerOfTen(width);
  return scaledValue < limit && scaledValue > -limit;
}

export function checkDecimalFitsWidth(scaledValue: bigint, width: number) {
  if (!decimalFitsWidth(scaledValue, width)) {
    throw new Error(
      `DECIMAL value has more digits than the width of ${width}: ${scaledValue}`
    );
  }
}

/**
 * The error for a DECIMAL type whose width the C API cannot report. It
 * returns a width and scale of 0 for types wider than 255 digits.
 */
export function decimalWidthUnknownError(): Error {
  return new Error(
    `DECIMAL types wider than ${MAX_DECIMAL_WIDTH} digits are not supported: ` +
      `the DuckDB C API does not expose their width and scale. ` +
      `Cast the values to VARCHAR instead.`
  );
}

/**
 * Parses the text DuckDB produces for a DECIMAL (e.g. `-12.340`) into the
 * value scaled by `scale`. Exact for any number of digits.
 */
export function scaledValueFromDecimalString(
  text: string,
  scale: number
): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2].length === 0 && !match[3])) {
    throw new Error(`Malformed DECIMAL text: ${text}`);
  }
  const fraction = match[3] ?? '';
  if (fraction.length > scale) {
    throw new Error(
      `DECIMAL text has more than ${scale} fractional digits: ${text}`
    );
  }
  const digits = match[2] + fraction.padEnd(scale, '0');
  const magnitude = BigInt(digits.length > 0 ? digits : '0');
  return match[1] ? -magnitude : magnitude;
}

/**
 * Converts a double to the value of a DECIMAL scaled by `scale`, rounding
 * half away from zero. The double is expanded exactly (it is an integer
 * times a power of two), so the result does not depend on the size of a
 * 128-bit intermediate.
 */
export function scaledValueFromDouble(
  double: number,
  width: number,
  scale: number
): bigint {
  if (!Number.isFinite(double)) {
    throw new Error(`Cannot convert ${double} to a DECIMAL`);
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, double);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n !== 0n;
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  // double = mantissa * 2^exponent
  const mantissa =
    biasedExponent === 0 ? fraction : fraction | 0x10000000000000n;
  const exponent = (biasedExponent === 0 ? 1 : biasedExponent) - 1075;
  let magnitude = mantissa * powerOfTen(scale);
  if (exponent >= 0) {
    magnitude <<= BigInt(exponent);
  } else {
    const shift = BigInt(-exponent);
    const half = 1n << (shift - 1n);
    magnitude = (magnitude + half) >> shift;
  }
  const scaledValue = negative ? -magnitude : magnitude;
  if (!decimalFitsWidth(scaledValue, width)) {
    throw new Error(
      `Cannot convert ${double} to DECIMAL(${width},${scale}): value is out of range`
    );
  }
  return scaledValue;
}
