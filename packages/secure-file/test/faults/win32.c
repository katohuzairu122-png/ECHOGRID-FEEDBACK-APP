/* Test-only syscall wrappers: production binding.gyp never includes this file. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdlib.h>
#include <string.h>
static BOOL WINAPI test_write(HANDLE, LPCVOID, DWORD, LPDWORD, LPOVERLAPPED);
static BOOL WINAPI test_flush(HANDLE);
static BOOL WINAPI test_disposition(HANDLE, FILE_INFO_BY_HANDLE_CLASS, LPVOID, DWORD);
static BOOL WINAPI test_close(HANDLE);
#define WriteFile test_write
#define FlushFileBuffers test_flush
#define SetFileInformationByHandle test_disposition
#define CloseHandle test_close
#include "../../native/secure_file_win.c"
#undef WriteFile
#undef FlushFileBuffers
#undef SetFileInformationByHandle
#undef CloseHandle
static int fault(const char* name) {
  char value[64]; DWORD n = GetEnvironmentVariableA("SF_TEST_FAULT", value, sizeof value);
  return n > 0 && n < sizeof value && strcmp(value, name) == 0;
}
static HANDLE closed_file = NULL;
static BOOL WINAPI test_write(HANDLE h, LPCVOID data, DWORD len, LPDWORD done, LPOVERLAPPED overlapped) {
  if (fault("disk-full")) { *done = 0; SetLastError(ERROR_DISK_FULL); return FALSE; }
  if (fault("disk-partial") || fault("disk-partial-cleanup")) {
    LARGE_INTEGER zero = {0}, position;
    if (!SetFilePointerEx(h, zero, &position, FILE_CURRENT)) return FALSE;
    if (position.QuadPart > 0) { *done = 0; SetLastError(ERROR_DISK_FULL); return FALSE; }
    return WriteFile(h, data, len > 1 ? 1 : len, done, overlapped);
  }
  return WriteFile(h, data, len, done, overlapped);
}
static BOOL WINAPI test_flush(HANDLE h) {
  if (fault("flush-full") || fault("flush-full-cleanup")) { SetLastError(ERROR_DISK_FULL); return FALSE; }
  return FlushFileBuffers(h);
}
static BOOL WINAPI test_disposition(HANDLE h, FILE_INFO_BY_HANDLE_CLASS type, LPVOID data, DWORD size) {
  if (fault("file-close") && h == closed_file) {
    SetEnvironmentVariableA("SF_TEST_STALE_HANDLE_REUSED", "1");
    SetLastError(ERROR_INVALID_HANDLE); return FALSE;
  }
  if ((type == FileDispositionInfo || type == SF_FileDispositionInfoEx) && (fault("disk-partial-cleanup") || fault("flush-full-cleanup"))) {
    SetLastError(ERROR_ACCESS_DENIED); return FALSE;
  }
  return SetFileInformationByHandle(h, type, data, size);
}
static BOOL WINAPI test_close(HANDLE h) {
  if (fault("file-close") && h == closed_file) {
    SetEnvironmentVariableA("SF_TEST_STALE_HANDLE_REUSED", "1");
    SetLastError(ERROR_INVALID_HANDLE); return FALSE;
  }
  FILE_STANDARD_INFO info;
  int file = GetFileInformationByHandleEx(h, FileStandardInfo, &info, sizeof info) && !info.Directory;
  BOOL result = CloseHandle(h);
  if (file && fault("file-close")) { closed_file = h; SetLastError(ERROR_INVALID_HANDLE); return FALSE; }
  return result;
}
