import { setInterval } from 'node:timers';
import { SecureFile } from '../../index.js';
// Synthetic fixture only. Keep the unfinished handle reachable until forced exit.
globalThis.unfinished = SecureFile.prepare(process.argv[3]);
if (process.argv[2] === 'partial') globalThis.unfinished.verify().write(new Uint8Array([17, 29, 43]));
process.send({ ready: true });
setInterval(() => {}, 1000);
