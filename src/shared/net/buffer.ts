/** Growable little-endian binary writer / reader over DataView. */
export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  offset = 0;
  constructor(size = 256) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }
  private ensure(n: number) {
    if (this.offset + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.offset + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.offset));
    this.buf = nb;
    this.view = new DataView(nb);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; return this; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.offset, v); this.offset += 1; return this; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; return this; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.offset, v, true); this.offset += 2; return this; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; return this; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; return this; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; return this; }
  bytes(b: Uint8Array) { this.ensure(b.length); new Uint8Array(this.buf, this.offset, b.length).set(b); this.offset += b.length; return this; }
  finish(): Uint8Array { return new Uint8Array(this.buf, 0, this.offset); }
}

export class Reader {
  private view: DataView;
  offset = 0;
  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get remaining() { return this.data.byteLength - this.offset; }
  u8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  i8() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64() { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }
  rest(): Uint8Array { const r = this.data.subarray(this.offset); this.offset = this.data.byteLength; return r; }
}
