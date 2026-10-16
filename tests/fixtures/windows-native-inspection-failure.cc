// Only the separate conformance artifact uses this translation unit. The
// shipped addon always compiles filesystem.cc directly, without interposition.
#include "../../native/windows/src/authority.hpp"
#include <atomic>

static std::atomic_int failSnapshotCloseCount{0};

static bool isSnapshotDestination(HANDLE handle) {
  std::array<wchar_t, 32768> coordinate{};
  const auto length = GetFinalPathNameByHandleW(handle, coordinate.data(), coordinate.size(), FILE_NAME_NORMALIZED);
  if (length == 0 || length >= coordinate.size()) return false;
  const std::wstring path(coordinate.data(), length);
  return length > 13 && path.rfind(L"\\snapshot.bin") == length - 13;
}

extern "C" BOOL WINAPI __real_CloseHandle(HANDLE handle);
extern "C" BOOL WINAPI __wrap_CloseHandle(HANDLE handle) {
  if (failSnapshotCloseCount.load(std::memory_order_acquire) > 0 &&
      isSnapshotDestination(handle) &&
      failSnapshotCloseCount.fetch_sub(1, std::memory_order_acq_rel) > 0) {
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return __real_CloseHandle(handle);
}

static BOOL fixtureDisposition(HANDLE handle, FILE_INFO_BY_HANDLE_CLASS kind,
                               LPVOID value, DWORD size) {
  // A real NTFS runtime is created normally. Fail its first rollback
  // disposition so the verifier can observe the owner after post-create
  // validation fails, independent of host filesystem behavior.
  static std::atomic_flag failed = ATOMIC_FLAG_INIT;
  if (kind == FileDispositionInfo && !failed.test_and_set()) {
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return SetFileInformationByHandle(handle, kind, value, size);
}

static DWORD inspectionSecurityInfo(HANDLE handle, SE_OBJECT_TYPE kind,
                                    SECURITY_INFORMATION information,
                                    PSID* owner, PSID* group, PACL* dacl, PACL* sacl,
                                    PSECURITY_DESCRIPTOR* descriptor) {
  // Force validation to fail only after FILE_CREATE has allocated the root.
  static std::atomic_flag failed = ATOMIC_FLAG_INIT;
  wchar_t enabled[2];
  if (GetEnvironmentVariableW(L"REA_NATIVE_CREATION_FAILURE", enabled, 2) > 0 &&
      !failed.test_and_set()) return ERROR_ACCESS_DENIED;
  return GetSecurityInfo(handle, kind, information, owner, group, dacl, sacl, descriptor);
}

#define SetFileInformationByHandle fixtureDisposition
#define GetSecurityInfo inspectionSecurityInfo
#define filesystemCall fixtureFilesystemCall
#include "../../native/windows/src/filesystem.cc"
#undef filesystemCall

namespace rea {

napi_value filesystemCall(napi_env env, const std::wstring& operation,
                          const std::vector<napi_value>& args, RuntimeContext& context) {
  auto result = fixtureFilesystemCall(env, operation, args, context);
  if (operation == L"runtime_snapshot")
    failSnapshotCloseCount.store(2, std::memory_order_release);
  return result;
}

} // namespace rea
