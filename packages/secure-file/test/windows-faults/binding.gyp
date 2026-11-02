{
  "targets": [{
    "target_name": "secure_file_faults",
    "sources": ["../faults/addon.c", "../faults/win32.c"],
    "defines": ["NAPI_VERSION=9"],
    "libraries": ["advapi32.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": { "AdditionalOptions": ["/W4", "/WX", "/guard:cf"] },
      "VCLinkerTool": { "AdditionalOptions": ["/DYNAMICBASE", "/NXCOMPAT", "/guard:cf"] }
    }
  }]
}
