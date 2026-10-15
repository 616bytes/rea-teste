/* Source-owned fixture for the Ghidra loader-relocation boundary. */
typedef unsigned int rea_loader_word;

__attribute__((used)) volatile rea_loader_word rea_loader_value = 0x11111111u;

#if defined(__APPLE__)
#define REA_LOADER_POINTER_SECTION "__DATA_CONST,__const"
#else
#define REA_LOADER_POINTER_SECTION ".data.rel.ro"
#endif

/* The loader must fill this pointer before its read-only-after-relocation block is sealed. */
__attribute__((used, section(REA_LOADER_POINTER_SECTION)))
const volatile rea_loader_word *const rea_loader_pointer = &rea_loader_value;

__attribute__((noinline, used, visibility("default")))
rea_loader_word rea_loader_reader(void) {
  return *rea_loader_pointer;
}

__attribute__((used, visibility("default"))) void rea_loader_start(void) {
  volatile rea_loader_word result = rea_loader_reader();
  (void)result;
  for (;;) {
  }
}

#undef REA_LOADER_POINTER_SECTION
