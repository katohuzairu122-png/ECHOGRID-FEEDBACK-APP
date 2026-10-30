/*
 * S08-SEC-FILE-1 DEV-01: shared native secure-file primitive (internal platform interface).
 *
 * Lifecycle: PREPARE -> VERIFY -> WRITE -> FLUSH/CLOSE. The file is created exclusively with owner-only protection established AT CREATION, every
 * security property is then verified through the OPEN HANDLE (the path is never reopened), secret bytes are written only after verification, and any
 * failure aborts: the half-written file is removed only if the directory entry still names the very file this handle created. There is no insecure
 * fallback and no post-write permission repair. Errors carry a stable code and an OS error number only: never a path fragment or any secret byte.
 */
#ifndef SECURE_FILE_H
#define SECURE_FILE_H
#include <stddef.h>

typedef enum {
  SF_OK = 0,
  SF_E_ARGUMENT,        /* null/empty/oversized input, embedded NUL */
  SF_E_PATH,            /* relative path, '..' or '.' component, empty component, unsupported prefix/namespace */
  SF_E_SYMLINK,         /* symlink / junction / reparse point on the path or as the target */
  SF_E_NOT_DIRECTORY,   /* a path component is not a directory */
  SF_E_UNSAFE_PARENT,   /* parent directory owner/permission makes substitution possible */
  SF_E_EXISTS,          /* target already exists (never overwritten) */
  SF_E_UNSUPPORTED,     /* platform/filesystem cannot provide the required guarantees (fail closed) */
  SF_E_CREATE,          /* creation failed for another OS reason */
  SF_E_VERIFY,          /* a verified property did not hold */
  SF_E_IDENTITY,        /* the directory entry no longer names the file this handle created */
  SF_E_STATE,           /* lifecycle violation (write before verify, use after close/abort, ...) */
  SF_E_WRITE,           /* write failed or was short */
  SF_E_FLUSH,           /* flush/close failed */
  SF_E_TOO_LARGE,       /* total payload exceeds SF_MAX_BYTES */
  SF_E_INTERNAL
} sf_code;

#define SF_MAX_BYTES (1u << 20) /* a keyring/KEK file is tiny; refuse anything that is not */
#define SF_MAX_PATH_BYTES 4096

typedef struct { sf_code code; long os_error; } sf_status;
typedef struct sf_file sf_file;

/* Creates the file (exclusive, owner-only). On success *out is a PREPARED handle. */
sf_status sf_prepare(const char* utf8_path, sf_file** out);
/* Verifies owner, protection, type, link count, identity and entry binding through the handle. PREPARED -> VERIFIED. */
sf_status sf_verify(sf_file* f);
/* Appends bytes. Only legal once VERIFIED. A failure aborts the file. */
sf_status sf_write(sf_file* f, const unsigned char* data, size_t len);
/* Flushes data and the directory entry, closes. VERIFIED -> CLOSED. A failure aborts the file. */
sf_status sf_close(sf_file* f);
/* Idempotent: removes the file iff it is still the one this handle created, closes, and releases the handle. Safe on any state. */
void sf_abort(sf_file* f);
/* Releases the handle memory after sf_close/sf_abort. */
void sf_free(sf_file* f);
/* Stable code names for the JavaScript layer. */
const char* sf_code_name(sf_code c);

#endif
