import duckdb from '@duckdb/node-bindings';
import {
  DuckDBDecimalType,
} from '../DuckDBType';
import {
  DuckDBDecimalValue,
} from '../values';
import { checkDecimalFitsWidth } from '../conversion/wideDecimal';
import { DuckDBVector } from './DuckDBVector';
import { DuckDBValidity } from './DuckDBValidity';
import {
  getBigNumFromBytes,
  getBytesFromBigNum,
  getStringBytes,
  vectorData,
} from './dataAccessors';

/**
 * A DECIMAL wider than 38 digits. DuckDB stores the unscaled value of such a
 * decimal as a BIGNUM blob, so this vector reads and writes it exactly.
 */
export class DuckDBDecimalBigNumVector extends DuckDBVector<DuckDBDecimalValue> {
  private readonly decimalType: DuckDBDecimalType;
  private readonly dataView: DataView;
  private readonly validity: DuckDBValidity;
  private readonly vector: duckdb.Vector;
  private readonly itemOffset: number;
  private readonly _itemCount: number;
  // Indexed from the root vector's first row, so a slice shares these with
  // its parent: a write through either is visible to both.
  private readonly itemCache: (DuckDBDecimalValue | null | undefined)[];
  private readonly itemCacheDirty: boolean[];
  constructor(
    decimalType: DuckDBDecimalType,
    dataView: DataView,
    validity: DuckDBValidity,
    vector: duckdb.Vector,
    itemOffset: number,
    itemCount: number,
    itemCache: (DuckDBDecimalValue | null | undefined)[] = [],
    itemCacheDirty: boolean[] = []
  ) {
    super();
    this.decimalType = decimalType;
    this.dataView = dataView;
    this.validity = validity;
    this.vector = vector;
    this.itemOffset = itemOffset;
    this._itemCount = itemCount;
    this.itemCache = itemCache;
    this.itemCacheDirty = itemCacheDirty;
  }
  static fromRawVector(
    decimalType: DuckDBDecimalType,
    vector: duckdb.Vector,
    itemCount: number
  ): DuckDBDecimalBigNumVector {
    const data = vectorData(vector, itemCount * 16);
    const dataView = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
    const validity = DuckDBValidity.fromVector(vector, itemCount);
    return new DuckDBDecimalBigNumVector(
      decimalType,
      dataView,
      validity,
      vector,
      0,
      itemCount
    );
  }
  public override get type(): DuckDBDecimalType {
    return this.decimalType;
  }
  public override get itemCount(): number {
    return this._itemCount;
  }
  public override getItem(itemIndex: number): DuckDBDecimalValue | null {
    const cachedItem = this.itemCache[this.itemOffset + itemIndex];
    if (cachedItem !== undefined) {
      return cachedItem;
    }
    if (!this.validity.itemValid(itemIndex)) {
      return null;
    }
    const bytes = getStringBytes(this.dataView, itemIndex * 16);
    return new DuckDBDecimalValue(
      getBigNumFromBytes(bytes),
      this.decimalType.width,
      this.decimalType.scale
    );
  }
  public getScaledValue(itemIndex: number): bigint | null {
    const item = this.getItem(itemIndex);
    return item ? item.value : null;
  }
  public override setItem(itemIndex: number, value: DuckDBDecimalValue | null) {
    if (value != null) {
      // DuckDB does not validate the blob, so a value with more digits than
      // the width would be stored outside the type.
      checkDecimalFitsWidth(value.value, this.decimalType.width);
    }
    this.itemCache[this.itemOffset + itemIndex] = value;
    this.validity.setItemValid(itemIndex, value != null);
    this.itemCacheDirty[this.itemOffset + itemIndex] = true;
  }
  public override flush() {
    for (let itemIndex = 0; itemIndex < this._itemCount; itemIndex++) {
      if (this.itemCacheDirty[this.itemOffset + itemIndex]) {
        const cachedItem = this.itemCache[this.itemOffset + itemIndex];
        if (cachedItem !== undefined && cachedItem !== null) {
          duckdb.vector_assign_string_element_len(
            this.vector,
            this.itemOffset + itemIndex,
            getBytesFromBigNum(cachedItem.value)
          );
        }
        this.itemCacheDirty[this.itemOffset + itemIndex] = false;
      }
    }
    this.validity.flush(this.vector);
  }
  public override slice(offset: number, length: number): DuckDBDecimalBigNumVector {
    return new DuckDBDecimalBigNumVector(
      this.decimalType,
      new DataView(
        this.dataView.buffer,
        this.dataView.byteOffset + offset * 16,
        length * 16
      ),
      this.validity.slice(offset),
      this.vector,
      this.itemOffset + offset,
      length,
      this.itemCache,
      this.itemCacheDirty
    );
  }
}
