import { createRequire } from 'node:module';

/**
 * S08-SEC-FILE-1 DEV-01. Lifecycle: prepare -> verify -> write -> close. See native/secure_file.h for the guarantees.
 * Secrets are accepted only as Buffer/Uint8Array. Errors expose `code` and `osError`, never a path fragment or a secret byte.
 */
const native = createRequire(import.meta.url)('./build/Release/secure_file.node');

const TOKEN = Symbol('SecureFile.construct');

export class SecureFile {
  #h;
  constructor(token, handle) {
    if (token !== TOKEN) throw new TypeError('SecureFile is created with SecureFile.prepare()');
    this.#h = handle;
  }
  /** Creates the file exclusively with owner-only protection established at creation. Throws, leaving nothing behind, on any failure. */
  static prepare(path) {
    if (typeof path !== 'string' || !path.isWellFormed()) { const e = new Error('secure-file: ARGUMENT'); e.code = 'ARGUMENT'; e.osError = 0; throw e; }
    return new SecureFile(TOKEN, native.prepare(path));
  }
  /** Verifies owner, protection, type, link count, identity and directory-entry binding through the open handle. A failure removes the file. */
  verify() { native.verify(this.#h); return this; }
  /** Writes bytes; legal only after verify(). A failure removes the file. */
  write(bytes) { native.write(this.#h, bytes); return this; }
  /** Flushes the file and its directory entry, then closes. A failure removes the file. */
  close() { native.close(this.#h); }
  /** Idempotent. Removes the file only if it is still the one this handle created. */
  abort() { native.abort(this.#h); }
}

/** One-shot: create exclusively, verify, write, flush, close. Any failure leaves no file behind. */
export function writeSecretFileExclusive(path, bytes) {
  const f = SecureFile.prepare(path);
  try {
    f.verify();
    f.write(bytes);
    f.close();
  } catch (e) {
    f.abort();
    throw e;
  }
}
