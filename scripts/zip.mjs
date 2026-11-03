// Read and rewrite members of a zip (a VSIX is one) in plain Node.
//
// Not `unzip` and `zip`: Git for Windows ships `unzip` but not `zip`, Windows'
// own `tar.exe` reads a zip but cannot replace one member of it, and GNU tar
// has no zip format at all. `zlib` is in every Node.
//
// Scope is what vsce writes: deflate or store, no zip64, no encryption, one
// disk. Anything else is refused by name rather than misread.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// A zip may end in a comment of up to 64 KiB after its end record.
const END_SEARCH = 22 + 0xffff;
// General purpose flag bit 3: sizes and CRC follow the data instead of
// preceding it. The rewrite puts them in the local header, so it drops the bit.
const DESCRIPTOR = 0x8;
const STORE = 0;
const DEFLATE = 8;

/** Archive paths from the central directory, without extracting payloads. */
export function names(file) {
  return members(readFileSync(file)).map((member) => member.name);
}

/** One member's bytes, decompressed and CRC-checked. */
export function entry(file, name) {
  const archive = readFileSync(file);
  const member = members(archive).find((m) => m.name === name);
  if (!member) throw new Error(`${file} has no ${name}`);
  return content(archive, member);
}

/**
 * Write every member under `prefix` into `dir`, keeping its archive path, and
 * return how many files it wrote. A directory member is created even when
 * empty, as `unzip` does.
 */
export function extract(file, prefix, dir) {
  const archive = readFileSync(file);
  const wanted = members(archive).filter((m) => m.name.startsWith(prefix));
  let files = 0;
  for (const member of wanted) {
    const target = join(dir, ...member.name.split('/'));
    if (member.name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content(archive, member));
    files++;
  }
  return files;
}

/** Rewrite `file` in place with member `name` holding `bytes`; every other member is copied as is. */
export function replace(file, name, bytes) {
  const archive = readFileSync(file);
  const all = members(archive);
  if (!all.some((m) => m.name === name)) throw new Error(`${file} has no ${name}`);

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const member of all) {
    const replaced = member.name === name;
    // A member is copied still compressed, so it is inflated once first: a
    // recorded size short of its data would otherwise copy a cut stream.
    if (!replaced) content(archive, member);
    const data = replaced ? zlib.deflateRawSync(bytes) : stored(archive, member);
    const fields = replaced
      ? {
          ...member,
          // APPNOTE 4.4.3: deflate needs version 2.0 to extract.
          needs: Math.max(member.needs, 20),
          method: DEFLATE,
          crc: zlib.crc32(bytes),
          packed: data.length,
          size: bytes.length
        }
      : member;
    const local = localHeader(fields);
    locals.push(local, data);
    centrals.push(centralHeader(fields, offset));
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centrals);
  writeFileSync(
    file,
    Buffer.concat([...locals, central, endRecord(all.length, central.length, offset)])
  );
}

function members(archive) {
  const end = archive.lastIndexOf(signature(END), archive.length - 22);
  if (end < 0 || end < archive.length - END_SEARCH) throw new Error('not a zip: no end record');
  const count = archive.readUInt16LE(end + 10);
  if (archive.readUInt16LE(end + 4) !== 0 || count !== archive.readUInt16LE(end + 8))
    throw new Error('multi-disk zip is not supported');
  if (count === 0xffff || archive.readUInt32LE(end + 16) === 0xffffffff)
    throw new Error('zip64 is not supported');

  const list = [];
  const centralAt = archive.readUInt32LE(end + 16);
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== CENTRAL) throw new Error(`bad central record ${i}`);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const member = {
      made: archive.readUInt16LE(at + 4),
      needs: archive.readUInt16LE(at + 6),
      flags: archive.readUInt16LE(at + 8),
      method: archive.readUInt16LE(at + 10),
      time: archive.readUInt16LE(at + 12),
      date: archive.readUInt16LE(at + 14),
      crc: archive.readUInt32LE(at + 16),
      packed: archive.readUInt32LE(at + 20),
      size: archive.readUInt32LE(at + 24),
      internal: archive.readUInt16LE(at + 36),
      external: archive.readUInt32LE(at + 38),
      offset: archive.readUInt32LE(at + 42),
      // Member data lies before the central directory. Inflate stops at the
      // stream's end, so a last member recorded too long still inflates to
      // the right size and CRC; only this bound refuses it.
      limit: centralAt,
      name: archive.toString('utf8', at + 46, at + 46 + nameLength),
      extra: archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      comment: archive.subarray(
        at + 46 + nameLength + extraLength,
        at + 46 + nameLength + extraLength + commentLength
      )
    };
    if (member.flags & 0x1) throw new Error(`${member.name} is encrypted`);
    if (member.method !== STORE && member.method !== DEFLATE)
      throw new Error(`${member.name} uses compression method ${member.method}`);
    // A zip name separates with `/` only; on win32 `join` also splits on `\`.
    if (
      member.name.includes('\\') ||
      member.name.split('/').some((part) => part === '..') ||
      /^(\/|[A-Za-z]:)/.test(member.name)
    )
      throw new Error(`${member.name} escapes the archive`);
    list.push(member);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return list;
}

/** The member's data exactly as stored, still compressed. */
function stored(archive, member) {
  const at = member.offset;
  if (archive.readUInt32LE(at) !== LOCAL) throw new Error(`bad local record for ${member.name}`);
  const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  if (start + member.packed > member.limit)
    throw new Error(`${member.name} runs past the archive's member data`);
  return archive.subarray(start, start + member.packed);
}

function content(archive, member) {
  const data = stored(archive, member);
  const bytes = member.method === DEFLATE ? inflate(member.name, data) : data;
  if (bytes.length !== member.size || zlib.crc32(bytes) !== member.crc)
    throw new Error(`${member.name} does not match its recorded size and CRC`);
  return bytes;
}

// zlib's own message ("unexpected end of file") names no member.
function inflate(name, data) {
  try {
    return zlib.inflateRawSync(data);
  } catch (error) {
    throw new Error(`${name} does not inflate: ${error.message}`, { cause: error });
  }
}

function localHeader(m) {
  const name = Buffer.from(m.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL, 0);
  head.writeUInt16LE(m.needs, 4);
  head.writeUInt16LE(m.flags & ~DESCRIPTOR, 6);
  head.writeUInt16LE(m.method, 8);
  head.writeUInt16LE(m.time, 10);
  head.writeUInt16LE(m.date, 12);
  head.writeUInt32LE(m.crc, 14);
  head.writeUInt32LE(m.packed, 18);
  head.writeUInt32LE(m.size, 22);
  head.writeUInt16LE(name.length, 26);
  return Buffer.concat([head, name]);
}

function centralHeader(m, offset) {
  const name = Buffer.from(m.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL, 0);
  head.writeUInt16LE(m.made, 4);
  head.writeUInt16LE(m.needs, 6);
  head.writeUInt16LE(m.flags & ~DESCRIPTOR, 8);
  head.writeUInt16LE(m.method, 10);
  head.writeUInt16LE(m.time, 12);
  head.writeUInt16LE(m.date, 14);
  head.writeUInt32LE(m.crc, 16);
  head.writeUInt32LE(m.packed, 20);
  head.writeUInt32LE(m.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(m.extra.length, 30);
  head.writeUInt16LE(m.comment.length, 32);
  head.writeUInt16LE(m.internal, 36);
  head.writeUInt32LE(m.external, 38);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, name, m.extra, m.comment]);
}

function endRecord(count, size, offset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return end;
}

function signature(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
