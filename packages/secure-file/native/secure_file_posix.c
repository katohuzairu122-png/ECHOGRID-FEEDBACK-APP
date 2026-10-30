#define _GNU_SOURCE
#include "secure_file.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <sys/types.h>
#include <unistd.h>

/*
 * POSIX/Linux implementation.
 *  - The path must be absolute. Every component is opened with openat(O_NOFOLLOW|O_DIRECTORY) relative to the previous directory descriptor starting at "/",
 *    so no component can be swapped for a symlink or another tree between checks and use (no pathname is ever resolved twice).
 *  - The file is created with openat(O_CREAT|O_EXCL|O_NOFOLLOW, 0600) relative to the verified parent descriptor, forced to exactly 0600 on the descriptor
 *    BEFORE any secret byte exists (umask can only remove bits; fchmod makes it exact), then verified through fstat on the descriptor.
 *  - The entry binding is re-checked with fstatat(AT_SYMLINK_NOFOLLOW) on the retained parent descriptor, and cleanup uses unlinkat on that same
 *    descriptor only if (dev, ino) still match, so it can never delete a substituted file.
 */
typedef enum { ST_PREPARED = 1, ST_VERIFIED, ST_CLOSED, ST_ABORTED } sf_state;

struct sf_file {
  int fd;
  int dirfd;
  char name[256];
  dev_t dev;
  ino_t ino;
  uid_t uid;
  size_t written;
  sf_state state;
};

static sf_status st(sf_code c, long e) { sf_status s; s.code = c; s.os_error = e; return s; }

static void close_quiet(int fd) { if (fd >= 0) { int e = errno; close(fd); errno = e; } }

/* A parent that others can write to would let them rename entries underneath us; allow it only when sticky (like /tmp) or owned by us/root-exclusive. */
static sf_code check_directory_safe(const struct stat* s, uid_t euid) {
  if (!S_ISDIR(s->st_mode)) return SF_E_NOT_DIRECTORY;
  if (s->st_uid != euid && s->st_uid != 0) return SF_E_UNSAFE_PARENT;
  if ((s->st_mode & (S_IWGRP | S_IWOTH)) && !(s->st_mode & S_ISVTX)) return SF_E_UNSAFE_PARENT;
  return SF_OK;
}

/* Owner-only mode bits, link counts and identity are only trustworthy on local POSIX filesystems. Anything else (NFS, FUSE, 9p/drvfs, vfat, proc...) fails closed. */
static int fs_supported(int fd) {
  struct statfs sfs;
  if (fstatfs(fd, &sfs) != 0) return 0;
  switch ((unsigned long)sfs.f_type) {
    case 0xEF53UL:      /* ext2/3/4 */
    case 0x58465342UL:  /* xfs */
    case 0x9123683EUL:  /* btrfs */
    case 0xF2F52010UL:  /* f2fs */
    case 0x01021994UL:  /* tmpfs */
    case 0x794C7630UL:  /* overlayfs (container root filesystems) */
      return 1;
    default:
      return 0;
  }
}

static int fsync_retry(int fd) { int r; do { r = fsync(fd); } while (r != 0 && errno == EINTR); return r; }

sf_status sf_prepare(const char* path, sf_file** out) {
  *out = NULL;
  if (!path || path[0] == '\0') return st(SF_E_ARGUMENT, 0);
  size_t n = strlen(path);
  if (n >= SF_MAX_PATH_BYTES) return st(SF_E_ARGUMENT, 0);
  if (path[0] != '/') return st(SF_E_PATH, 0);

  char buf[SF_MAX_PATH_BYTES];
  memcpy(buf, path, n + 1);
  const uid_t euid = geteuid();
  int dirfd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (dirfd < 0) return st(SF_E_CREATE, errno);

  /* Ancestor policy: every directory on the path (including "/") must be owned by the caller or root and must not be group/other-writable unless sticky.
   * Anyone who could rename or replace an ancestor could redirect the walk into a tree they control. */
  {
    struct stat rs;
    if (fstat(dirfd, &rs) != 0) { int e = errno; close_quiet(dirfd); return st(SF_E_CREATE, e); }
    sf_code rc = check_directory_safe(&rs, euid);
    if (rc != SF_OK) { close_quiet(dirfd); return st(rc, 0); }
  }
  char* p = buf + 1;
  char* name = NULL;
  for (;;) {
    char* slash = strchr(p, '/');
    if (slash) *slash = '\0';
    if (p[0] == '\0' || strcmp(p, ".") == 0 || strcmp(p, "..") == 0) { close_quiet(dirfd); return st(SF_E_PATH, 0); }
    if (strlen(p) > 255) { close_quiet(dirfd); return st(SF_E_PATH, 0); }
    if (!slash) { name = p; break; }
    int next = openat(dirfd, p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      int e = errno;
      if (e == ELOOP) { close_quiet(dirfd); return st(SF_E_SYMLINK, e); }
      if (e == ENOTDIR) {
        /* O_NOFOLLOW|O_DIRECTORY on a symlink yields ENOTDIR on Linux; tell a symlink from a plain file without following it. */
        struct stat ls;
        int sym = fstatat(dirfd, p, &ls, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(ls.st_mode);
        close_quiet(dirfd);
        return st(sym ? SF_E_SYMLINK : SF_E_NOT_DIRECTORY, e);
      }
      close_quiet(dirfd);
      return st(SF_E_CREATE, e);
    }
    struct stat as;
    if (fstat(next, &as) != 0) { int e = errno; close_quiet(next); close_quiet(dirfd); return st(SF_E_CREATE, e); }
    sf_code ac = check_directory_safe(&as, euid);
    if (ac != SF_OK) { close_quiet(next); close_quiet(dirfd); return st(ac, 0); }
    close_quiet(dirfd);
    dirfd = next;
    p = slash + 1;
  }

  struct stat ds;
  if (fstat(dirfd, &ds) != 0) { int e = errno; close_quiet(dirfd); return st(SF_E_CREATE, e); }
  sf_code dc = check_directory_safe(&ds, euid);
  if (dc != SF_OK) { close_quiet(dirfd); return st(dc, 0); }
  if (!fs_supported(dirfd)) { close_quiet(dirfd); return st(SF_E_UNSUPPORTED, 0); }

  int fd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    int e = errno;
    close_quiet(dirfd);
    if (e == EEXIST) return st(SF_E_EXISTS, e); /* includes an existing or dangling symlink: O_EXCL never follows it */
    if (e == ELOOP) return st(SF_E_SYMLINK, e);
    return st(SF_E_CREATE, e);
  }
  /* From here the file exists: every failure must remove it, and only it. */
  struct stat fs;
  if (fstat(fd, &fs) != 0) {
    /* Identity could not be read. Nothing was written and the name was just created exclusively, so the only thing that can be at it now is our empty file
     * unless a same-uid/root actor intervened (outside the threat model); remove it. */
    int e = errno;
    unlinkat(dirfd, name, 0);
    close_quiet(fd); close_quiet(dirfd);
    return st(SF_E_CREATE, e);
  }
  sf_file* f = (sf_file*)calloc(1, sizeof(sf_file));
  if (!f) { /* identity is known: remove only our own file */
    struct stat cs;
    if (fstatat(dirfd, name, &cs, AT_SYMLINK_NOFOLLOW) == 0 && cs.st_dev == fs.st_dev && cs.st_ino == fs.st_ino) unlinkat(dirfd, name, 0);
    close_quiet(fd); close_quiet(dirfd); return st(SF_E_INTERNAL, ENOMEM);
  }
  f->fd = fd; f->dirfd = dirfd; f->dev = fs.st_dev; f->ino = fs.st_ino; f->uid = euid; f->state = ST_PREPARED;
  memcpy(f->name, name, strlen(name) + 1);
  if (fchmod(fd, 0600) != 0) { int e = errno; sf_abort(f); sf_free(f); return st(SF_E_CREATE, e); }
  *out = f;
  return st(SF_OK, 0);
}

static sf_status verify_locked(sf_file* f) {
  struct stat fs, es;
  if (fstat(f->fd, &fs) != 0) return st(SF_E_VERIFY, errno);
  if (!S_ISREG(fs.st_mode)) return st(SF_E_VERIFY, 0);
  if ((fs.st_mode & 07777) != 0600) return st(SF_E_VERIFY, 0);
  if (fs.st_uid != f->uid) return st(SF_E_VERIFY, 0);
  if (fs.st_nlink != 1) return st(SF_E_VERIFY, 0); /* a hard link elsewhere would expose the bytes */
  if (fs.st_dev != f->dev || fs.st_ino != f->ino) return st(SF_E_IDENTITY, 0);
  if ((size_t)fs.st_size != f->written) return st(SF_E_VERIFY, 0); /* nothing but our own writes may have changed the length */
  /* An extended POSIX ACL (inherited from a default ACL on the parent) would leave named-user/group entries on the file even though the mask is zero. */
  if (fgetxattr(f->fd, "system.posix_acl_access", NULL, 0) >= 0) return st(SF_E_VERIFY, 0);
  if (errno != ENODATA && errno != ENOTSUP) return st(SF_E_VERIFY, errno);
  /* The directory entry must still name exactly this file (not a rename-substituted one, not a symlink). */
  if (fstatat(f->dirfd, f->name, &es, AT_SYMLINK_NOFOLLOW) != 0) return st(SF_E_IDENTITY, errno);
  if (es.st_dev != f->dev || es.st_ino != f->ino || !S_ISREG(es.st_mode)) return st(SF_E_IDENTITY, 0);
  return st(SF_OK, 0);
}

sf_status sf_verify(sf_file* f) {
  if (!f || f->state != ST_PREPARED) return st(SF_E_STATE, 0);
  sf_status s = verify_locked(f);
  if (s.code != SF_OK) { sf_abort(f); return s; }
  f->state = ST_VERIFIED;
  return st(SF_OK, 0);
}

sf_status sf_write(sf_file* f, const unsigned char* data, size_t len) {
  if (!f || f->state != ST_VERIFIED) return st(SF_E_STATE, 0);
  if (len > SF_MAX_BYTES || f->written + len > SF_MAX_BYTES) { sf_abort(f); return st(SF_E_TOO_LARGE, 0); }
  /* Re-check identity and exactness immediately before secret bytes are written (cheap, handle based). */
  sf_status v = verify_locked(f);
  if (v.code != SF_OK) { sf_abort(f); return v; }
  size_t off = 0;
  while (off < len) {
    ssize_t w = write(f->fd, data + off, len - off);
    if (w < 0) { if (errno == EINTR) continue; int e = errno; sf_abort(f); return st(SF_E_WRITE, e); }
    if (w == 0) { sf_abort(f); return st(SF_E_WRITE, 0); }
    off += (size_t)w;
  }
  f->written += len;
  return st(SF_OK, 0);
}

sf_status sf_close(sf_file* f) {
  if (!f || f->state != ST_VERIFIED) return st(SF_E_STATE, 0);
  if (fsync_retry(f->fd) != 0) { int e = errno; sf_abort(f); return st(SF_E_FLUSH, e); }
  if (fsync_retry(f->dirfd) != 0) { int e = errno; sf_abort(f); return st(SF_E_FLUSH, e); }
  sf_status fin = verify_locked(f); /* the final state on disk is still exactly what was verified */
  if (fin.code != SF_OK) { sf_abort(f); return fin; }
  if (close(f->fd) != 0) { int e = errno; f->fd = -1; sf_abort(f); return st(SF_E_FLUSH, e); }
  f->fd = -1;
  close_quiet(f->dirfd); f->dirfd = -1;
  f->state = ST_CLOSED;
  return st(SF_OK, 0);
}

void sf_abort(sf_file* f) {
  if (!f || f->state == ST_CLOSED || f->state == ST_ABORTED) return;
  if (f->dirfd >= 0) {
    struct stat es;
    /* Remove only the file this handle created; a substituted entry is left alone. POSIX has no unlink-if-inode, so the check and the unlink are two steps.
     * The window is closed against every principal except the caller's own uid and root: the parent and all ancestors are owned by us/root and not
     * group/other-writable, or sticky (then only the owner of an entry may remove or rename it, and nobody else can free our name for a substitute).
     * A same-uid attacker can already read and rewrite the file, so this is outside the threat model; it is a documented residual, not a silent one. */
    if (fstatat(f->dirfd, f->name, &es, AT_SYMLINK_NOFOLLOW) == 0 && es.st_dev == f->dev && es.st_ino == f->ino) unlinkat(f->dirfd, f->name, 0);
  }
  close_quiet(f->fd); f->fd = -1;
  close_quiet(f->dirfd); f->dirfd = -1;
  f->state = ST_ABORTED;
}

void sf_free(sf_file* f) { if (!f) return; sf_abort(f); free(f); }

const char* sf_code_name(sf_code c) {
  switch (c) {
    case SF_OK: return "OK"; case SF_E_ARGUMENT: return "ARGUMENT"; case SF_E_PATH: return "PATH"; case SF_E_SYMLINK: return "SYMLINK";
    case SF_E_NOT_DIRECTORY: return "NOT_DIRECTORY"; case SF_E_UNSAFE_PARENT: return "UNSAFE_PARENT"; case SF_E_EXISTS: return "EXISTS";
    case SF_E_UNSUPPORTED: return "UNSUPPORTED"; case SF_E_CREATE: return "CREATE"; case SF_E_VERIFY: return "VERIFY"; case SF_E_IDENTITY: return "IDENTITY";
    case SF_E_STATE: return "STATE"; case SF_E_WRITE: return "WRITE"; case SF_E_FLUSH: return "FLUSH"; case SF_E_TOO_LARGE: return "TOO_LARGE";
    default: return "INTERNAL";
  }
}
