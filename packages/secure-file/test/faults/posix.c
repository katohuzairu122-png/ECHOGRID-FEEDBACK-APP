#define _GNU_SOURCE
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static int test_unlinkat(int, const char*, int);
static ssize_t test_write(int, const void*, size_t);
static int test_fstat(int, struct stat*);
static int test_close(int);
#define unlinkat test_unlinkat
#define write test_write
#define fstat test_fstat
#define close test_close
#include "../../native/secure_file_posix.c"
#undef unlinkat
#undef write
#undef fstat
#undef close
static int fault(const char* name) { const char* v = getenv("SF_TEST_FAULT"); return v && strcmp(v, name) == 0; }
static int test_unlinkat(int fd, const char* name, int flags) {
  if (fault("cleanup") || fault("partial-cleanup")) { errno = EACCES; return -1; }
  return unlinkat(fd, name, flags);
}
static ssize_t test_write(int fd, const void* data, size_t len) {
  if (fault("destroy-substitute")) {
    const char* path = getenv("SF_TEST_PATH");
    if (!path || strlen(path) > 4000) { errno = EINVAL; return -1; }
    char moved[4096]; snprintf(moved, sizeof moved, "%s-original", path);
    if (rename(path, moved) != 0) return -1;
    int other = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (other < 0) return -1;
    ssize_t n = write(other, "substitute", 10); close(other);
    if (n != 10) { errno = EIO; return -1; }
  }
  if (fault("partial") || fault("partial-cleanup")) {
    off_t position = lseek(fd, 0, SEEK_CUR);
    if (position > 0) { errno = EIO; return -1; }
    return write(fd, data, len > 1 ? 1 : len);
  }
  return write(fd, data, len);
}

static int test_fstat(int fd, struct stat* result) {
  int r = fstat(fd, result);
  if (r == 0 && (fcntl(fd, F_GETFL) & O_ACCMODE) == O_WRONLY && S_ISREG(result->st_mode) && fault("identity")) { errno = EIO; return -1; }
  return r;
}

static int test_close(int fd) {
  struct stat info;
  int regular = (fcntl(fd, F_GETFL) & O_ACCMODE) == O_WRONLY && fstat(fd, &info) == 0 && S_ISREG(info.st_mode);
  int r = close(fd);
  if (regular && fault("close")) { errno = EIO; return -1; }
  return r;
}
