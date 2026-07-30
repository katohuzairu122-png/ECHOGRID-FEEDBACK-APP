/**
 * Like `Partial<T>`, but every optional property may also be explicitly
 * `undefined`. Under `exactOptionalPropertyTypes`, a plain `Partial<T>`
 * rejects a present-but-`undefined` value, so update-patch parameters built
 * from optional DTO/form fields (which are `T | undefined`) need this instead.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
