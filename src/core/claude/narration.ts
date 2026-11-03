/**
 * Whether a `thinking` block is **narration**: the server's summary of the prose
 * the model wrote between tool calls, sent in place of that prose.
 *
 * Observed 2026-09-23 on 2.1.280 with `claude-opus-5-5`, first on 2026-09-06
 * with 2.1.258 and `claude-fable-5-1` (161 blocks across a month of transcripts
 * here; none from `claude-opus-5`). The block is `type: "thinking"` on the wire
 * and on disk alike, so a reader that drops thinking drops what the model said —
 * which is how a question reading "send the message above?" reached the dock
 * with nothing above it. The CLI's own terminal draws these as prose with a
 * trailing "· summarized".
 *
 * **The tag is inside the signature, and nowhere else on disk.** The pipe also
 * carries `narration_block_indexes` beside `message`, but the `.jsonl` does not,
 * so this reads the signature for both halves — one rule, and the one the CLI
 * itself runs (the 2.1.280 bundle, found by grepping it for
 * `narration_classifier_error`): base64, then protobuf field 2,
 * its field 1, its field 8 as a string, equal to `narration`. Fail-closed like
 * theirs: anything that does not walk is ordinary thinking.
 *
 * Empty text is ordinary thinking too — the CLI documents that a listed block
 * can arrive with none, and says to treat it so.
 */
export function narrationText(block: {
  type?: unknown;
  thinking?: unknown;
  signature?: unknown;
}): string | undefined {
  if (block.type !== 'thinking' || typeof block.thinking !== 'string') {
    return undefined;
  }
  if (!block.thinking.trim() || typeof block.signature !== 'string') {
    return undefined;
  }
  const envelope = field(field(Buffer.from(block.signature, 'base64'), 2), 1);
  const kind = field(envelope, 8);
  return kind?.toString('utf8') === 'narration' ? block.thinking : undefined;
}

/**
 * The last length-delimited field `n` of one protobuf message, or nothing when
 * it is absent or the message does not walk. Last rather than first, as the
 * CLI's walk keeps overwriting.
 */
function field(bytes: Buffer | undefined, n: number): Buffer | undefined {
  if (!bytes) {
    return undefined;
  }
  let found: Buffer | undefined;
  let at = 0;
  while (at < bytes.length) {
    const tag = varint(bytes, at);
    if (!tag) {
      return undefined;
    }
    at = tag.next;
    switch (tag.value % 8) {
      case 0: {
        const skipped = varint(bytes, at);
        if (!skipped) {
          return undefined;
        }
        at = skipped.next;
        break;
      }
      case 1:
        at += 8;
        break;
      case 2: {
        const length = varint(bytes, at);
        if (!length || length.value > bytes.length - length.next) {
          return undefined;
        }
        at = length.next + length.value;
        if (Math.floor(tag.value / 8) === n) {
          found = bytes.subarray(length.next, at);
        }
        break;
      }
      case 5:
        at += 4;
        break;
      default:
        return undefined;
    }
    if (at > bytes.length) {
      return undefined;
    }
  }
  return found;
}

/** A varint at `at`, or nothing when the bytes run out first. Arithmetic
 *  rather than bit shifts, which stop at 32 bits. */
function varint(bytes: Buffer, at: number): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let i = at; i < bytes.length && i < at + 10; i++) {
    const byte = bytes[i] ?? 0;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) {
      return { value, next: i + 1 };
    }
    scale *= 128;
  }
  return undefined;
}
