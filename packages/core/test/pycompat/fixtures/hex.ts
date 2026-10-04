/** Test-only helper: decode the big-endian IEEE-754 hex strings written by
 * gen.py (`struct.pack('>d', x).hex()`) back into JS numbers, with zero risk
 * of decimal round-off — see gen.py's module doc comment for why hex (not
 * JSON numbers) is used for floats in cases.json. */
export function hexToDouble(hex: string): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  for (let i = 0; i < 8; i++) {
    view.setUint8(i, parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return view.getFloat64(0);
}
