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
 *    descriptor only if (dev, ino) still match, to avoid deleting an observed substitute. The same-UID/root check/unlink race remains outside the threat model.
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
  int remove_on_abort; /* existing files are close-only until verified destruction */
  sf_state state;
  sf_status cleanup;
};

static sf_status st(sf_code c, long e) { sf_status s = {0}; s.code = c; s.os_error = e; return s; }

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

/* Required kernel boundary: without protected_hardlinks, a foreign UID can link
 * an owner-only file from a searchable directory. Link-count snapshots alone do
 * not close the race. Read the real procfs setting through no-follow descriptors;
 * unavailable, malformed, disabled or non-procfs evidence always fails closed.
 * Changes by root/mount administrators remain outside the unprivileged threat model.
 */
static int hardlink_setting_enabled(const char* value, size_t size) {
  return size == 2 && value[0] == '1' && value[1] == '\n';
}

static int hardlinks_protected(void) {
  const char* components[] = { "sys", "fs", "protected_hardlinks" };
  int fd = open("/proc", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 0;
  for (size_t i = 0; i < 3; ++i) {
    struct statfs fs;
    if (fstatfs(fd, &fs) != 0 || (unsigned long)fs.f_type != 0x9fa0UL) { close_quiet(fd); return 0; }
    int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (i < 2) flags |= O_DIRECTORY;
    int next = openat(fd, components[i], flags);
    close_quiet(fd);
    if (next < 0) return 0;
    fd = next;
  }
  struct statfs fs;
  struct stat entry;
  if (fstatfs(fd, &fs) != 0 || (unsigned long)fs.f_type != 0x9fa0UL ||
      fstat(fd, &entry) != 0 || !S_ISREG(entry.st_mode) || entry.st_uid != 0) {
    close_quiet(fd); return 0;
  }
  char value[8]; size_t used = 0;
  while (used < sizeof(value)) {
    ssize_t n = read(fd, value + used, sizeof(value) - used);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { close_quiet(fd); return 0; }
    if (n == 0) break;
    used += (size_t)n;
  }
  close_quiet(fd);
  return hardlink_setting_enabled(value, used);
}

static int fsync_retry(int fd) { int r; do { r = fsync(fd); } while (r != 0 && errno == EINTR); return r; }

static sf_status open_file(const char* path, sf_file** out, int existing) {
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
      return st(existing && e == ENOENT ? SF_E_MISSING : SF_E_CREATE, e);
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

  if (!hardlinks_protected()) { close_quiet(dirfd); return st(SF_E_UNSUPPORTED, 0); }

  int fd = openat(dirfd, name, O_WRONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (existing ? 0 : O_CREAT | O_EXCL), 0600);
  if (fd < 0) {
    int e = errno;
    close_quiet(dirfd);
    if (existing && e == ENOENT) return st(SF_E_MISSING, e);
    if (e == EEXIST) return st(SF_E_EXISTS, e); /* includes an existing or dangling symlink: O_EXCL never follows it */
    if (e == ELOOP) return st(SF_E_SYMLINK, e);
    return st(SF_E_CREATE, e);
  }
  /* From here the file exists: every failure must remove it, and only it. */
  struct stat fs;
  if (fstat(fd, &fs) != 0) {
    /* Unknown identity: leave the empty entry untouched and report incomplete cleanup. */
    int e = errno;
    close_quiet(fd); close_quiet(dirfd);
    sf_status failure = st(SF_E_CREATE, e);
    if (!existing) failure.cleanup_code = SF_E_IDENTITY;
    return failure;
  }
  sf_file* f = (sf_file*)calloc(1, sizeof(sf_file));
  if (!f) {
    sf_file temporary = {0};
    temporary.fd = fd; temporary.dirfd = dirfd; temporary.dev = fs.st_dev; temporary.ino = fs.st_ino;
    temporary.state = ST_PREPARED; temporary.remove_on_abort = !existing; memcpy(temporary.name, name, strlen(name) + 1);
    sf_status cleanup = sf_abort(&temporary);
    sf_status failure = st(SF_E_INTERNAL, ENOMEM);
    failure.cleanup_code = cleanup.code; failure.cleanup_os_error = cleanup.os_error;
    return failure;
  }
  f->fd = fd; f->dirfd = dirfd; f->dev = fs.st_dev; f->ino = fs.st_ino; f->uid = euid; f->state = ST_PREPARED; f->remove_on_abort = !existing;
  if (existing) f->written = fs.st_size < 0 ? SF_MAX_BYTES + 1 : (unsigned long long)fs.st_size > SF_MAX_BYTES ? SF_MAX_BYTES + 1 : (size_t)fs.st_size;
  memcpy(f->name, name, strlen(name) + 1);
  if (!existing && fchmod(fd, 0600) != 0) {
    sf_status failure = st(SF_E_CREATE, errno), cleanup = sf_abort(f);
    failure.cleanup_code = cleanup.code; failure.cleanup_os_error = cleanup.os_error;
    sf_free(f); return failure;
  }
  *out = f;
  return st(SF_OK, 0);
}

sf_status sf_prepare(const char* path, sf_file** out) { return open_file(path, out, 0); }

static sf_status verify_locked(sf_file* f) {
  if (!hardlinks_protected()) return st(SF_E_UNSUPPORTED, 0);
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


sf_status sf_destroy(const char* path) {
  sf_file* f = NULL;
  sf_status result = open_file(path, &f, 1);
  if (result.code != SF_OK) return result;
  result = verify_locked(f);
  if (result.code == SF_OK && f->written > SF_MAX_BYTES) result = st(SF_E_TOO_LARGE, 0);
  unsigned char zeros[4096] = {0};
  size_t done = 0;
  while (result.code == SF_OK && done < f->written) {
    size_t count = f->written - done;
    if (count > sizeof zeros) count = sizeof zeros;
    ssize_t n = write(f->fd, zeros, count);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { result = st(SF_E_WRITE, n < 0 ? errno : 0); break; }
    done += (size_t)n;
  }
  if (result.code == SF_OK && fsync_retry(f->fd) != 0) result = st(SF_E_FLUSH, errno);
  if (result.code == SF_OK) result = verify_locked(f);
  if (result.code == SF_OK) f->remove_on_abort = 1;
  /* On any earlier failure, close only: existing evidence is not ours to unlink. */
  sf_status cleanup = sf_abort(f);
  if (result.code == SF_OK) result = cleanup;
  else { result.cleanup_code = cleanup.code; result.cleanup_os_error = cleanup.os_error; }
  sf_free(f);
  return result;
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
  if (close(f->dirfd) != 0) {
    int e = errno; f->dirfd = -1; f->state = ST_ABORTED;
    f->cleanup = st(SF_E_CLEANUP, e); return st(SF_E_FLUSH, e);
  }
  f->dirfd = -1;
  f->state = ST_CLOSED;
  return st(SF_OK, 0);
}

sf_status sf_abort(sf_file* f) {
  if (!f) return st(SF_OK, 0);
  if (f->state == ST_CLOSED || f->state == ST_ABORTED) return f->cleanup;
  if (f->remove_on_abort && f->dirfd >= 0) {
    struct stat es;
    if (fstatat(f->dirfd, f->name, &es, AT_SYMLINK_NOFOLLOW) != 0) {
      /* Missing/substituted names do not establish removal of our original inode. */
      f->cleanup = st(SF_E_CLEANUP, errno);
    } else if (es.st_dev != f->dev || es.st_ino != f->ino) {
      f->cleanup = st(SF_E_IDENTITY, 0);
    } else if (unlinkat(f->dirfd, f->name, 0) != 0) {
      f->cleanup = st(SF_E_CLEANUP, errno);
    }
  }
  int close_error = 0;
  if (f->fd >= 0 && close(f->fd) != 0) close_error = errno;
  f->fd = -1;
  if (f->dirfd >= 0 && close(f->dirfd) != 0 && close_error == 0) close_error = errno;
  f->dirfd = -1;
  if (close_error != 0 && f->cleanup.code == SF_OK) f->cleanup = st(SF_E_CLEANUP, close_error);
  f->state = ST_ABORTED;
  return f->cleanup;
}
sf_status sf_cleanup_result(sf_file* f) { return f ? f->cleanup : st(SF_OK, 0); }

void sf_free(sf_file* f) { if (!f) return; sf_abort(f); free(f); }

const char* sf_code_name(sf_code c) {
  switch (c) {
    case SF_E_MISSING: return "MISSING"; case SF_E_CLEANUP: return "CLEANUP"; case SF_OK: return "OK"; case SF_E_ARGUMENT: return "ARGUMENT"; case SF_E_PATH: return "PATH"; case SF_E_SYMLINK: return "SYMLINK";
    case SF_E_NOT_DIRECTORY: return "NOT_DIRECTORY"; case SF_E_UNSAFE_PARENT: return "UNSAFE_PARENT"; case SF_E_EXISTS: return "EXISTS";
    case SF_E_UNSUPPORTED: return "UNSUPPORTED"; case SF_E_CREATE: return "CREATE"; case SF_E_VERIFY: return "VERIFY"; case SF_E_IDENTITY: return "IDENTITY";
    case SF_E_STATE: return "STATE"; case SF_E_WRITE: return "WRITE"; case SF_E_FLUSH: return "FLUSH"; case SF_E_TOO_LARGE: return "TOO_LARGE";
    default: return "INTERNAL";
  }
}
