// How many big jobs the server runs at once (matching a teacher's answer
// PDF, marking a section), worked out from its memory: each job holds pages
// and question papers in memory while they go to OpenAI. With 10 GB a
// school's PDFs all go together; with 512 MB they go one at a time, since two
// at once ran that server out of memory.
import os from 'node:os';
import v8 from 'node:v8';

const MB = 1024 * 1024;
// For the app itself, uploads and the pages it serves.
const RESERVED = 400 * MB;

// Node can use only as much as its heap limit, which fly.toml raises
// (NODE_OPTIONS) to fit the machine's memory.
const usable = Math.min(os.totalmem(), v8.getHeapStatistics().heap_size_limit);

export const jobsAtOnce = (megabytesEach) => Math.max(1, Math.floor((usable - RESERVED) / (megabytesEach * MB)));
