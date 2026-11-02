/* Test-only translation unit: no fault switches in the shipped native module. */
#include <node_api.h>
#ifdef _WIN32
#include <windows.h>
#endif
#include <stdlib.h>
#include <string.h>
static napi_status test_external(napi_env, void*, napi_finalize, void*, napi_value*);
static napi_status test_tag(napi_env, napi_value, const napi_type_tag*);
#define napi_create_external test_external
#define napi_type_tag_object test_tag
#include "../../native/addon.c"
#undef napi_create_external
#undef napi_type_tag_object
static int fault(const char* name) {
#ifdef _WIN32
  char value[64]; DWORD n = GetEnvironmentVariableA("SF_TEST_FAULT", value, sizeof value);
  return n > 0 && n < sizeof value && strcmp(value, name) == 0;
#else
  const char* v = getenv("SF_TEST_FAULT"); return v && strcmp(v, name) == 0;
#endif
}
static napi_status test_external(napi_env env, void* data, napi_finalize fin, void* hint, napi_value* out) {
  if (fault("registration")) return napi_generic_failure;
  return napi_create_external(env, data, fin, hint, out);
}
static napi_status test_tag(napi_env env, napi_value value, const napi_type_tag* tag) {
  if (fault("tag")) return napi_generic_failure;
  return napi_type_tag_object(env, value, tag);
}
