#include <node_api.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "secure_file.h"

/* Node-API glue. Secrets enter only as Buffer/Uint8Array (never a JS string, which would leave immutable copies); errors carry code + OS error only. */
#define NAPI_OK_OR(call) do { if ((call) != napi_ok) return NULL; } while (0)

/* Type tag so unwrap() accepts only externals created by THIS addon (a foreign external would otherwise be cast to sf_file*). */
static const napi_type_tag SF_TAG = { 0x5ecf11e0a5ec0001ULL, 0x08f11e1d0e5ec002ULL };

static void throw_status(napi_env env, sf_status s) {
  napi_value msg = NULL, err = NULL, code = NULL, os = NULL;
  char text[96];
  snprintf(text, sizeof text, "secure-file: %s", sf_code_name(s.code));
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &msg) != napi_ok || napi_create_error(env, NULL, msg, &err) != napi_ok || !err) { napi_throw_error(env, NULL, "secure-file: INTERNAL"); return; }
  if (napi_create_string_utf8(env, sf_code_name(s.code), NAPI_AUTO_LENGTH, &code) == napi_ok) napi_set_named_property(env, err, "code", code);
  if (napi_create_int64(env, (int64_t)s.os_error, &os) == napi_ok) napi_set_named_property(env, err, "osError", os);
  if (s.cleanup_code != SF_OK) {
    napi_value cleanup;
    if (napi_create_object(env, &cleanup) == napi_ok) {
      if (napi_create_string_utf8(env, sf_code_name(s.cleanup_code), NAPI_AUTO_LENGTH, &code) == napi_ok) napi_set_named_property(env, cleanup, "code", code);
      if (napi_create_int64(env, s.cleanup_os_error, &os) == napi_ok) napi_set_named_property(env, cleanup, "osError", os);
      napi_set_named_property(env, err, "cleanupError", cleanup);
    }
  }
  napi_throw(env, err);
}

static sf_status with_cleanup(sf_file* f, sf_status original) {
  sf_status cleanup = sf_cleanup_result(f);
  original.cleanup_code = cleanup.code;
  original.cleanup_os_error = cleanup.os_error;
  return original;
}
static void finalize(napi_env env, void* data, void* hint) {
  (void)env; (void)hint;
  sf_status cleanup = sf_abort((sf_file*)data);
  /* Finalizers cannot throw into application control flow. Fixed diagnostic only. */
  if (cleanup.code != SF_OK) fputs("secure-file: finalizer cleanup failed; explicit abort required for observable recovery\n", stderr);
  sf_free((sf_file*)data);
}

static sf_file* unwrap(napi_env env, napi_callback_info info, size_t argc_want, napi_value* argv) {
  size_t argc = argc_want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  void* p = NULL;
  bool tagged = false;
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_external) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  if (napi_check_object_type_tag(env, argv[0], &SF_TAG, &tagged) != napi_ok || !tagged || napi_get_value_external(env, argv[0], &p) != napi_ok || !p) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  /* A validated handle still owns an unfinished file when a later argument is
     absent. Abort it without reading the missing argv slot; preserve cleanup
     failure separately from the original argument error. */
  if (argc < argc_want) { sf_abort((sf_file*)p); throw_status(env, with_cleanup((sf_file*)p, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 })); return NULL; }
  return (sf_file*)p;
}

static napi_value Prepare(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_OK_OR(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  napi_valuetype t;
  if (argc < 1 || napi_typeof(env, argv[0], &t) != napi_ok || t != napi_string) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  /* Measure first and reject, rather than let the engine truncate (at a character boundary) or substitute U+FFFD: the file must be created at exactly the path asked for. */
  size_t need = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &need) != napi_ok || need == 0 || need >= SF_MAX_PATH_BYTES) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  char path[SF_MAX_PATH_BYTES + 1]; size_t n = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof path, &n) != napi_ok || n != need || strlen(path) != n || strstr(path, "\xEF\xBF\xBD") != NULL) { throw_status(env, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 }); return NULL; }
  sf_file* f = NULL;
  sf_status s = sf_prepare(path, &f);
  if (s.code != SF_OK) { throw_status(env, s); return NULL; }
  napi_value ext;
  if (napi_create_external(env, f, finalize, NULL, &ext) != napi_ok) {
    sf_abort(f); sf_status failure = with_cleanup(f, (sf_status){ SF_E_INTERNAL, 0, SF_OK, 0 });
    sf_free(f); throw_status(env, failure); return NULL;
  }
  /* External owns f from here. Abort releases OS resources, but only its finalizer frees storage. */
  if (napi_type_tag_object(env, ext, &SF_TAG) != napi_ok) {
    sf_abort(f); throw_status(env, with_cleanup(f, (sf_status){ SF_E_INTERNAL, 0, SF_OK, 0 })); return NULL;
  }
  return ext;
}

static napi_value Verify(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_status s = sf_verify(f); if (s.code != SF_OK) throw_status(env, with_cleanup(f, s)); return NULL;
}

static napi_value Write(napi_env env, napi_callback_info info) {
  napi_value argv[2]; sf_file* f = unwrap(env, info, 2, argv); if (!f) return NULL;
  /* Buffer is a Uint8Array; any other view (Uint16Array, DataView, ...) is refused so the byte contract is unambiguous. */
  bool is_ta = false; void* data = NULL; size_t len = 0;
  napi_is_typedarray(env, argv[1], &is_ta);
  napi_typedarray_type tt; napi_value ab; size_t off = 0;
  if (!is_ta || napi_get_typedarray_info(env, argv[1], &tt, &len, &data, &ab, &off) != napi_ok || tt != napi_uint8_array) { sf_abort(f); throw_status(env, with_cleanup(f, (sf_status){ SF_E_ARGUMENT, 0, SF_OK, 0 })); return NULL; }
  sf_status s = sf_write(f, (const unsigned char*)data, len); if (s.code != SF_OK) throw_status(env, with_cleanup(f, s)); return NULL;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_status s = sf_close(f); if (s.code != SF_OK) throw_status(env, with_cleanup(f, s)); return NULL;
}

static napi_value Abort(napi_env env, napi_callback_info info) {
  napi_value argv[1]; sf_file* f = unwrap(env, info, 1, argv); if (!f) return NULL;
  sf_status s = sf_abort(f); if (s.code != SF_OK) throw_status(env, s); return NULL;
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
