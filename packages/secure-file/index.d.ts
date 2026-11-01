export type SecureFileErrorCode =
  | 'ARGUMENT' | 'PATH' | 'SYMLINK' | 'NOT_DIRECTORY' | 'UNSAFE_PARENT' | 'EXISTS' | 'UNSUPPORTED' | 'CREATE' | 'VERIFY' | 'IDENTITY'
  | 'MISSING' | 'CLEANUP' | 'STATE' | 'WRITE' | 'FLUSH' | 'TOO_LARGE' | 'INTERNAL';
export interface SecureFileError extends Error { code: SecureFileErrorCode; osError: number; cleanupError?: { code: SecureFileErrorCode; osError: number } }
export declare class SecureFile {
  static prepare(path: string): SecureFile;
  verify(): this;
  write(bytes: Buffer | Uint8Array): this;
  close(): void;
  abort(): void;
}
export declare function writeSecretFileExclusive(path: string, bytes: Buffer | Uint8Array): void;

export declare function destroySecretFile(path: string): void;
