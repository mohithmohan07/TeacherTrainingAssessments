// Plain zip files, stored rather than deflated: the scanner helper's few
// small files, and the reports of a test, which are PDFs that hardly shrink.
// Names are written as UTF-8, so names in any script come through.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  if (zlib.crc32) return zlib.crc32(buffer);
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// The local header that goes before a file's data, and its entry in the
// central directory at the end, for a file starting at `offset`.
function records(entryName, data, offset, modified) {
  const name = Buffer.from(entryName, 'utf8');
  const { time, date } = dosDateTime(modified);
  const crc = crc32(data);
  const size = data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0x0800, 6); // names are UTF-8
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // made by: MS-DOS, zip 2.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  // extra length, comment length, disk number, internal and external attributes: all 0
  central.writeUInt32LE(offset, 42);

  return { local: Buffer.concat([local, name]), central: Buffer.concat([central, name]) };
}

function endRecord(count, directorySize, directoryOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return end;
}

// A zip made in memory. entries: [{ name, data: Buffer }].
export function buildZip(entries, modified = new Date()) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const { local, central } = records(entry.name, entry.data, offset, modified);
    parts.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  return Buffer.concat([...parts, directory, endRecord(entries.length, directory.length, offset)]);
}

// A zip written to disk a file at a time, so only one file is ever held in
// memory however large the zip grows.
export class ZipFile {
  static async create(file) {
    return new ZipFile(await fs.open(file, 'w'));
  }

  constructor(handle) {
    this.handle = handle;
    this.centrals = [];
    this.offset = 0;
  }

  async add(name, data, modified = new Date()) {
    const { local, central } = records(name, data, this.offset, modified);
    // A plain zip cannot point past 4 GB.
    if (this.offset + local.length + data.length > 0xffffffff) throw new Error('The zip would be larger than 4 GB.');
    await this.handle.write(local);
    await this.handle.write(data);
    this.centrals.push(central);
    this.offset += local.length + data.length;
  }

  // Writes the directory at the end and closes the file. Returns its size.
  async close() {
    const directory = Buffer.concat(this.centrals);
    await this.handle.write(directory);
    await this.handle.write(endRecord(this.centrals.length, directory.length, this.offset));
    await this.handle.close();
    return this.offset + directory.length + 22;
  }

  // Closes the file without finishing it, after a failure.
  async abandon() {
    await this.handle.close().catch(() => {});
  }
}
