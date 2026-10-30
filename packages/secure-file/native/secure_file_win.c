#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include "secure_file.h"
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

/*
 * Windows implementation (NTFS, local fixed volumes only).
 *  - The path must be a drive-absolute DOS path (X:\dir\file). UNC, \\?\ and \\.\ namespaces, '.'/'..' components, ':' stream syntax and reserved
 *    characters are rejected up front; the volume must be a local fixed NTFS volume that persists ACLs, otherwise creation FAILS CLOSED.
 *  - Directories are walked with NtCreateFile(FILE_OPEN, FILE_OPEN_REPARSE_POINT) relative to the previous directory HANDLE; a reparse point (symlink,
 *    junction, mount point) at any component is refused. The file is created with NtCreateFile(FILE_CREATE) relative to the verified parent handle with a
 *    PROTECTED, owner-only security descriptor supplied in OBJECT_ATTRIBUTES, so it is never visible with an inherited DACL, and with share mode 0.
 *  - Verification reads owner, DACL and identity back through the handle: owner == token user, DACL protected with exactly one non-inherited
 *    ACCESS_ALLOWED ACE for that user, not a directory, not a reparse point, one link, FILE_ID_INFO equal to the one captured at creation.
 *  - Cleanup deletes through the SAME handle (FILE_DISPOSITION_INFO_EX, POSIX semantics) so a substituted entry can never be removed.
 * STATUS: written for review; compiled only with mingw-w64 in DEV-01 and NOT executed on Windows. See the completion report.
 */
typedef NTSTATUS(NTAPI* NtCreateFile_t)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG(NTAPI* RtlNtStatusToDosError_t)(NTSTATUS);
#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x00000040
#endif
#ifndef STATUS_OBJECT_NAME_COLLISION
#define STATUS_OBJECT_NAME_COLLISION ((NTSTATUS)0xC0000035L)
#endif

/* FileDispositionInfoEx (class 21, Windows 10 RS1+) and its flags are cast/defined here so older SDK/mingw headers still compile; the runtime requires Windows 10 1607+. */
#define SF_FileDispositionInfoEx ((FILE_INFO_BY_HANDLE_CLASS)21)
#ifndef FILE_DISPOSITION_FLAG_DELETE
#define FILE_DISPOSITION_FLAG_DELETE 0x1
#endif
#ifndef FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
#define FILE_DISPOSITION_FLAG_POSIX_SEMANTICS 0x2
#endif
typedef struct { DWORD Flags; } sf_disposition_ex;

typedef enum { ST_PREPARED = 1, ST_VERIFIED, ST_CLOSED, ST_ABORTED } sf_state;
struct sf_file {
  HANDLE file;
  HANDLE dir;
  FILE_ID_INFO id;
  PSID user; /* LocalAlloc'd copy of the token user SID */
  size_t written;
  sf_state state;
};

static sf_status st(sf_code c, long e) { sf_status s; s.code = c; s.os_error = e; return s; }
static NtCreateFile_t pNtCreateFile;
static RtlNtStatusToDosError_t pToDos;
static INIT_ONCE g_once = INIT_ONCE_STATIC_INIT;
static void close_h(HANDLE* h) { if (*h && *h != INVALID_HANDLE_VALUE) CloseHandle(*h); *h = NULL; }

/* Resolved exactly once and published atomically (InitOnce), so concurrent Worker threads never observe a half-initialised pair. */
static BOOL CALLBACK load_ntdll_once(PINIT_ONCE o, PVOID p, PVOID* c) {
  (void)o; (void)p; (void)c;
  HMODULE m = GetModuleHandleW(L"ntdll.dll");
  if (!m) return FALSE;
  NtCreateFile_t a = (NtCreateFile_t)(void*)GetProcAddress(m, "NtCreateFile");
  RtlNtStatusToDosError_t b = (RtlNtStatusToDosError_t)(void*)GetProcAddress(m, "RtlNtStatusToDosError");
  if (!a || !b) return FALSE;
  pNtCreateFile = a; pToDos = b;
  return TRUE;
}
static int load_ntdll(void) { return InitOnceExecuteOnce(&g_once, load_ntdll_once, NULL, NULL) ? 1 : 0; }

/* Opens/creates `name` (UTF-16, no separators) relative to `parent`. */
static NTSTATUS open_rel(HANDLE parent, const wchar_t* name, ACCESS_MASK access, ULONG disposition, ULONG options, ULONG share, PSECURITY_DESCRIPTOR sd, HANDLE* out) {
  UNICODE_STRING us;
  us.Length = (USHORT)(wcslen(name) * sizeof(wchar_t));
  us.MaximumLength = us.Length;
  us.Buffer = (PWSTR)name;
  OBJECT_ATTRIBUTES oa;
  InitializeObjectAttributes(&oa, &us, OBJ_CASE_INSENSITIVE, parent, sd);
  IO_STATUS_BLOCK iosb;
  return pNtCreateFile(out, access | SYNCHRONIZE, &oa, &iosb, NULL, FILE_ATTRIBUTE_NORMAL, share, disposition, options | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
}

static sf_status token_user(PSID* out_sid, wchar_t** out_string) {
  HANDLE tok = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return st(SF_E_CREATE, (long)GetLastError());
  DWORD n = 0;
  GetTokenInformation(tok, TokenUser, NULL, 0, &n);
  TOKEN_USER* tu = (TOKEN_USER*)LocalAlloc(LPTR, n);
  sf_status r = st(SF_OK, 0);
  if (!tu || !GetTokenInformation(tok, TokenUser, tu, n, &n)) r = st(SF_E_CREATE, (long)GetLastError());
  else {
    DWORD len = GetLengthSid(tu->User.Sid);
    PSID copy = LocalAlloc(LPTR, len);
    if (!copy || !CopySid(len, copy, tu->User.Sid)) { r = st(SF_E_INTERNAL, (long)GetLastError()); if (copy) LocalFree(copy); }
    else if (!ConvertSidToStringSidW(copy, out_string)) { r = st(SF_E_INTERNAL, (long)GetLastError()); LocalFree(copy); }
    else *out_sid = copy;
  }
  if (tu) LocalFree(tu);
  CloseHandle(tok);
  return r;
}

static int bad_component_char(wchar_t c) { return c < 0x20 || wcschr(L"<>:\"/|?*", c) != NULL; }

static int utf8_to_wide(const char* s, wchar_t* out, int cap) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, out, cap);
  return n > 0;
}

/* Rejects a trailing dot/space (Win32 would silently strip it, aliasing another name) and reserved device names. */
static int reserved_or_aliased(const wchar_t* c) {
  size_t n = wcslen(c);
  if (n == 0 || c[n - 1] == L'.' || c[n - 1] == L' ') return 1;
  static const wchar_t* dev[] = { L"CON", L"PRN", L"AUX", L"NUL", L"COM1", L"COM2", L"COM3", L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9", L"LPT1", L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9" };
  wchar_t stem[16] = { 0 };
  size_t i = 0;
  while (c[i] && c[i] != L'.' && i < 15) { stem[i] = (wchar_t)towupper(c[i]); i++; }
  if (c[i] != 0 && c[i] != L'.') return 0;
  for (size_t k = 0; k < sizeof(dev) / sizeof(dev[0]); k++) if (wcscmp(stem, dev[k]) == 0) return 1;
  return 0;
}

static sf_status volume_ok(HANDLE h) {
  wchar_t fs[32];
  DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(h, NULL, 0, NULL, NULL, &flags, fs, 32)) return st(SF_E_UNSUPPORTED, (long)GetLastError());
  if (wcscmp(fs, L"NTFS") != 0 || !(flags & FILE_PERSISTENT_ACLS)) return st(SF_E_UNSUPPORTED, 0);
  FILE_REMOTE_PROTOCOL_INFO rp;
  if (GetFileInformationByHandleEx(h, FileRemoteProtocolInfo, &rp, sizeof(rp))) return st(SF_E_UNSUPPORTED, 0); /* succeeds only on remote handles */
  return st(SF_OK, 0);
}

sf_status sf_prepare(const char* path, sf_file** out) {
  *out = NULL;
  if (!path || path[0] == '\0') return st(SF_E_ARGUMENT, 0);
  if (strlen(path) >= SF_MAX_PATH_BYTES) return st(SF_E_ARGUMENT, 0);
  if (!load_ntdll()) return st(SF_E_UNSUPPORTED, 0);
  wchar_t w[SF_MAX_PATH_BYTES]; /* per call: no shared mutable state between threads (8 KB stack) */
  if (!utf8_to_wide(path, w, SF_MAX_PATH_BYTES)) return st(SF_E_ARGUMENT, 0);
  /* Drive-absolute DOS path only: "X:\..." */
  if (!(((w[0] >= L'A' && w[0] <= L'Z') || (w[0] >= L'a' && w[0] <= L'z')) && w[1] == L':' && w[2] == L'\\')) return st(SF_E_PATH, 0);

  { size_t wl = wcslen(w); if (wl == 0 || w[wl - 1] == L'\\') return st(SF_E_PATH, 0); } /* a trailing separator would silently drop the last name */
  wchar_t* comps[256];
  int nc = 0;
  for (wchar_t* p = w + 3; *p;) {
    if (nc >= 255) return st(SF_E_PATH, 0);
    comps[nc++] = p;
    wchar_t* s = wcschr(p, L'\\');
    if (!s) break;
    *s = 0;
    p = s + 1;
  }
  if (nc < 1) return st(SF_E_PATH, 0);
  for (int i = 0; i < nc; i++) {
    const wchar_t* c = comps[i];
    if (c[0] == 0 || wcscmp(c, L".") == 0 || wcscmp(c, L"..") == 0 || reserved_or_aliased(c)) return st(SF_E_PATH, 0);
    for (const wchar_t* q = c; *q; q++) if (bad_component_char(*q)) return st(SF_E_PATH, 0);
  }

  PSID user = NULL;
  wchar_t* sid_str = NULL;
  sf_status ts = token_user(&user, &sid_str);
  if (ts.code != SF_OK) return ts;

  /* Open the volume root through the DOS-device namespace, then walk by handle. Drive type must be fixed. */
  wchar_t root[4]; root[0] = w[0]; root[1] = L':'; root[2] = L'\\'; root[3] = 0;
  if (GetDriveTypeW(root) != DRIVE_FIXED) { LocalFree(user); LocalFree(sid_str); return st(SF_E_UNSUPPORTED, 0); }
  HANDLE dir = CreateFileW(root, FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (dir == INVALID_HANDLE_VALUE) { DWORD e = GetLastError(); LocalFree(user); LocalFree(sid_str); return st(SF_E_CREATE, (long)e); }

  sf_status r = volume_ok(dir);
  for (int i = 0; r.code == SF_OK && i < nc - 1; i++) {
    HANDLE next = NULL;
    NTSTATUS ns = open_rel(dir, comps[i], FILE_READ_ATTRIBUTES | FILE_TRAVERSE | FILE_LIST_DIRECTORY, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, &next);
    if (ns < 0) { r = st(SF_E_CREATE, (long)pToDos(ns)); break; }
    FILE_BASIC_INFO bi;
    if (!GetFileInformationByHandleEx(next, FileBasicInfo, &bi, sizeof(bi))) { r = st(SF_E_CREATE, (long)GetLastError()); CloseHandle(next); break; }
    if (bi.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { r = st(SF_E_SYMLINK, 0); CloseHandle(next); break; }
    if (!(bi.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) { r = st(SF_E_NOT_DIRECTORY, 0); CloseHandle(next); break; }
    CloseHandle(dir);
    dir = next;
  }
  if (r.code != SF_OK) { close_h(&dir); LocalFree(user); LocalFree(sid_str); return r; }

  /* Owner-only, PROTECTED (no inheritance) descriptor, owner explicitly the token user. FA = FILE_ALL_ACCESS. */
  size_t sl = wcslen(sid_str);
  if (sl > 180) { close_h(&dir); LocalFree(user); LocalFree(sid_str); return st(SF_E_INTERNAL, 0); }
  wchar_t sddl[2 * 184 + 24];
  if (swprintf(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%ls" L"D:P(A;;FA;;;%ls)", sid_str, sid_str) < 0) { close_h(&dir); LocalFree(user); LocalFree(sid_str); return st(SF_E_INTERNAL, 0); }
  PSECURITY_DESCRIPTOR sd = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, NULL)) {
    DWORD e = GetLastError(); close_h(&dir); LocalFree(user); LocalFree(sid_str); return st(SF_E_CREATE, (long)e);
  }
  LocalFree(sid_str);

  HANDLE fh = NULL;
  NTSTATUS ns = open_rel(dir, comps[nc - 1], GENERIC_WRITE | GENERIC_READ | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT, 0, sd, &fh);
  LocalFree(sd);
  if (ns < 0) {
    sf_code c = ns == STATUS_OBJECT_NAME_COLLISION ? SF_E_EXISTS : SF_E_CREATE;
    long e = (long)pToDos(ns);
    close_h(&dir); LocalFree(user);
    return st(c, e);
  }
  sf_file* f = (sf_file*)calloc(1, sizeof(sf_file));
  if (!f) {
    sf_disposition_ex di = { FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS };
    SetFileInformationByHandle(fh, SF_FileDispositionInfoEx, &di, sizeof(di));
    CloseHandle(fh); close_h(&dir); LocalFree(user); return st(SF_E_INTERNAL, 0);
  }
  f->file = fh; f->dir = dir; f->user = user; f->state = ST_PREPARED;
  if (!GetFileInformationByHandleEx(fh, FileIdInfo, &f->id, sizeof(f->id))) { long e = (long)GetLastError(); sf_abort(f); sf_free(f); return st(SF_E_UNSUPPORTED, e); }
  *out = f;
  return st(SF_OK, 0);
}

static sf_status verify_locked(sf_file* f) {
  FILE_BASIC_INFO bi; FILE_STANDARD_INFO si; FILE_ID_INFO id;
  if (GetFileType(f->file) != FILE_TYPE_DISK) return st(SF_E_VERIFY, 0);
  if (!GetFileInformationByHandleEx(f->file, FileBasicInfo, &bi, sizeof(bi)) || !GetFileInformationByHandleEx(f->file, FileStandardInfo, &si, sizeof(si)) ||
      !GetFileInformationByHandleEx(f->file, FileIdInfo, &id, sizeof(id))) return st(SF_E_VERIFY, (long)GetLastError());
  if ((bi.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || si.Directory) return st(SF_E_VERIFY, 0);
  if (si.NumberOfLinks != 1 || si.DeletePending) return st(SF_E_VERIFY, 0);
  if (memcmp(&id, &f->id, sizeof(id)) != 0) return st(SF_E_IDENTITY, 0);

  PSID owner = NULL; PACL dacl = NULL; PSECURITY_DESCRIPTOR sd = NULL;
  DWORD gr = GetSecurityInfo(f->file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &sd);
  if (gr != ERROR_SUCCESS) return st(SF_E_VERIFY, (long)gr);
  sf_status r = st(SF_OK, 0);
  SECURITY_DESCRIPTOR_CONTROL ctl = 0; DWORD rev = 0;
  if (!owner || !EqualSid(owner, f->user)) r = st(SF_E_VERIFY, 0);
  else if (!dacl || !GetSecurityDescriptorControl(sd, &ctl, &rev) || !(ctl & SE_DACL_PROTECTED)) r = st(SF_E_VERIFY, 0);
  else if (dacl->AceCount != 1) r = st(SF_E_VERIFY, 0);
  else {
    ACCESS_ALLOWED_ACE* ace = NULL;
    if (!GetAce(dacl, 0, (LPVOID*)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || (ace->Header.AceFlags & INHERITED_ACE) || !EqualSid((PSID)&ace->SidStart, f->user)) r = st(SF_E_VERIFY, 0);
    else if (ace->Mask != FILE_ALL_ACCESS) r = st(SF_E_VERIFY, 0); /* exact: no extra generic/maximum-allowed/system-security bits */
  }
  LocalFree(sd);
  return r;
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
  sf_status v = verify_locked(f);
  if (v.code != SF_OK) { sf_abort(f); return v; }
  size_t off = 0;
  while (off < len) {
    DWORD chunk = (DWORD)((len - off) > (1u << 20) ? (1u << 20) : (len - off)), w = 0;
    if (!WriteFile(f->file, data + off, chunk, &w, NULL) || w == 0) { long e = (long)GetLastError(); sf_abort(f); return st(SF_E_WRITE, e); }
    off += w;
  }
  f->written += len;
  return st(SF_OK, 0);
}

sf_status sf_close(sf_file* f) {
  if (!f || f->state != ST_VERIFIED) return st(SF_E_STATE, 0);
  if (!FlushFileBuffers(f->file)) { long e = (long)GetLastError(); sf_abort(f); return st(SF_E_FLUSH, e); }
  sf_status fin = verify_locked(f);
  if (fin.code != SF_OK) { sf_abort(f); return fin; }
  close_h(&f->file); close_h(&f->dir);
  f->state = ST_CLOSED;
  return st(SF_OK, 0);
}

void sf_abort(sf_file* f) {
  if (!f || f->state == ST_CLOSED || f->state == ST_ABORTED) return;
  if (f->file) {
    /* Delete through the creating handle: identity is intrinsic, a substituted entry is never touched. */
    sf_disposition_ex di = { FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS };
    if (!SetFileInformationByHandle(f->file, SF_FileDispositionInfoEx, &di, sizeof(di))) {
      /* Older/other semantics: classic delete-on-close through the same handle. Never leave a half-written secret behind silently. */
      FILE_DISPOSITION_INFO legacy; legacy.DeleteFile = TRUE;
      SetFileInformationByHandle(f->file, FileDispositionInfo, &legacy, sizeof(legacy));
    }
  }
  close_h(&f->file); close_h(&f->dir);
  f->state = ST_ABORTED;
}

void sf_free(sf_file* f) { if (!f) return; sf_abort(f); if (f->user) LocalFree(f->user); free(f); }

const char* sf_code_name(sf_code c) {
  switch (c) {
    case SF_OK: return "OK"; case SF_E_ARGUMENT: return "ARGUMENT"; case SF_E_PATH: return "PATH"; case SF_E_SYMLINK: return "SYMLINK";
    case SF_E_NOT_DIRECTORY: return "NOT_DIRECTORY"; case SF_E_UNSAFE_PARENT: return "UNSAFE_PARENT"; case SF_E_EXISTS: return "EXISTS";
    case SF_E_UNSUPPORTED: return "UNSUPPORTED"; case SF_E_CREATE: return "CREATE"; case SF_E_VERIFY: return "VERIFY"; case SF_E_IDENTITY: return "IDENTITY";
    case SF_E_STATE: return "STATE"; case SF_E_WRITE: return "WRITE"; case SF_E_FLUSH: return "FLUSH"; case SF_E_TOO_LARGE: return "TOO_LARGE";
    default: return "INTERNAL";
  }
}
