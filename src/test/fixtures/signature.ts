/**
 * A `thinking` block wearing a signature the way 2.1.280's does: protobuf, field
 * 2 holding field 1 holding the block kind as field 8. The real envelope carries
 * more around each level — a varint and a fixed64 stand in for it here, so the
 * walk is shown skipping what it does not read.
 */
export function thinkingBlock(
  thinking: string,
  kind: string
): { type: 'thinking'; thinking: string; signature: string } {
  const kindField = bytesField(8, Buffer.from(kind, 'utf8'));
  const inner = Buffer.concat([Buffer.from([0x10, 0x02]), bytesField(1, kindField)]);
  const outer = Buffer.concat([
    Buffer.from([0x08, 0x04]),
    Buffer.from([0x19, 1, 2, 3, 4, 5, 6, 7, 8]),
    bytesField(2, inner)
  ]);
  return { type: 'thinking', thinking, signature: outer.toString('base64') };
}

/** One length-delimited field. Every length here is under 128, so each varint
 *  is one byte. */
function bytesField(n: number, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(n << 3) | 2, bytes.length]), bytes]);
}
