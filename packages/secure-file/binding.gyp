{
  "targets": [{
    "target_name": "secure_file",
    "sources": ["native/addon.c"],
    "defines": ["NAPI_VERSION=9"],
    "conditions": [
      ["OS=='win'", { "sources": ["native/secure_file_win.c"], "libraries": ["advapi32.lib"], "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/W4", "/WX", "/guard:cf"] }, "VCLinkerTool": { "AdditionalOptions": ["/DYNAMICBASE", "/NXCOMPAT", "/guard:cf"] } } }],
      ["OS!='win'", { "sources": ["native/secure_file_posix.c"], "cflags": ["-Wall", "-Wextra", "-Werror", "-O2", "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2", "-fPIC"], "ldflags": ["-Wl,-z,relro,-z,now"] }]
    ]
  }]
}
