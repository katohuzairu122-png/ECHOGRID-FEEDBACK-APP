#include <node_api.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "secure_file.h"

/* Node-API glue. Secrets enter only as Buffer/Uint8Array (never a JS string, which would leave immutable copies); errors carry code + OS error only. */
#define NAPI_OK_OR(call) do { if ((call) != napi_ok) return NULL; } while (0)

static void throw_status(napi_env env, sf_status s) {
  napi_value msg, err, code, os;
  char text[96];
  snprintf(text, sizeof text, "secure-file: %s", sf_code_name(s.code));
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &msg);
  napi_create_error(env, NULL, msg, &err);
  napi_create_string_utf8(env, sf_code_name(s.code), NAPI_AUTO_LENGTH, &code);
  napi_create_int64(env, (int64_t)s.os_error, &os);
  napi_set_named_property(env, err, "code", code);
  napi_set_named_property(env, err, "osError", os);
  napi_throw(env, err);
}

static void finalize(napi_env env, void* data, void* hint) { (void)env; (void)hint; sf_free((sf_file*)data); }

static sf_file* unwrap(napi_env env, napi_callback_info info, size_t argc_want, napi_value* argv) {
  size_t argc = argc_want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0 }); return NULL; }
  void* p = NULL;
  if (napi_get_value_external(env, argv[0], &p) != napi_ok || !p) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0 }); return NULL; }
  return (sf_file*)p;
}

static napi_value Prepare(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_OK_OR(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  napi_valuetype t;
  if (argc < 1 || napi_typeof(env, argv[0], &t) != napi_ok || t != napi_string) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0 }); return NULL; }
  char path[SF_MAX_PATH_BYTES + 1]; size_t n = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof path, &n) != napi_ok || n == 0 || n >= SF_MAX_PATH_BYTES || strlen(path) != n) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0 }); return NULL; }
  sf_file* f = NULL;
  sf_status s = sf_prepare(path, &f);
  if (s.code != SF_OK) { throw_status(env, s); return NULL; }
  napi_value ext;
  if (napi_create_external(env, f, finalize, NULL, &ext) != napi_ok) { sf_free(f); throw_status(env, (sf_status){ SF_E_INTERNAL, 0 }); return NULL; }
  return ext;
}

static napi_value Verify(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_status s = sf_verify(f); if (s.code != SF_OK) throw_status(env, s); return NULL;
}

static napi_value Write(napi_env env, napi_callback_info info) {
  napi_value argv[2]; sf_file* f = unwrap(env, info, 2, argv); if (!f) return NULL;
  /* Buffer is a Uint8Array; any other view (Uint16Array, DataView, ...) is refused so the byte contract is unambiguous. */
  bool is_ta = false; void* data = NULL; size_t len = 0;
  napi_is_typedarray(env, argv[1], &is_ta);
  napi_typedarray_type tt; napi_value ab; size_t off = 0;
  if (!is_ta || napi_get_typedarray_info(env, argv[1], &tt, &len, &data, &ab, &off) != napi_ok || tt != napi_uint8_array) { sf_abort(f); throw_status(env, (sf_status){ SF_E_ARGUMENT, 0 }); return NULL; }
  sf_status s = sf_write(f, (const unsigned char*)data, len); if (s.code != SF_OK) throw_status(env, s); return NULL;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_status s = sf_close(f); if (s.code != SF_OK) throw_status(env, s); return NULL;
}

static napi_value Abort(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_abort(f); return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor d[] = {
    { "prepare", NULL, Prepare, NULL, NULL, NULL, napi_default, NULL }, { "verify", NULL, Verify, NULL, NULL, NULL, napi_default, NULL },
    { "write", NULL, Write, NULL, NULL, NULL, napi_default, NULL },     { "close", NULL, Close, NULL, NULL, NULL, napi_default, NULL },
    { "abort", NULL, Abort, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof d / sizeof d[0], d);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
