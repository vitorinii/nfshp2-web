// Outside Windows: the few Win32 names the runtime's portable files use, as harmless stand-ins. The keyboard reads the host's input
// block (host_input.h); timing is the C++ clock; the debug-only calls (thread pinning, priorities) do nothing.
#pragma once
#ifndef _WIN32
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <unistd.h>

#include "host_input.h"

typedef uint32_t DWORD;
typedef uint64_t DWORD64, ULONG64, ULONGLONG, DWORD_PTR;
typedef int32_t LONG;
typedef int BOOL;
typedef void *HANDLE, *LPVOID, *HWND;
#ifndef FALSE
#define FALSE 0
#define TRUE 1
#endif
#define MAX_PATH 260
#define INFINITE 0xFFFFFFFFu
#define HIGH_PRIORITY_CLASS 0
#define THREAD_PRIORITY_HIGHEST 0
#define THREAD_PRIORITY_TIME_CRITICAL 0

// virtual keys (Windows' numbers: hp2.ini keeps them)
enum {
    VK_LBUTTON = 0x01, VK_RBUTTON = 0x02, VK_MBUTTON = 0x04, VK_BACK = 0x08, VK_TAB = 0x09, VK_RETURN = 0x0D, VK_SHIFT = 0x10,
    VK_CONTROL = 0x11, VK_MENU = 0x12, VK_CAPITAL = 0x14, VK_ESCAPE = 0x1B, VK_SPACE = 0x20, VK_PRIOR = 0x21, VK_NEXT = 0x22,
    VK_END = 0x23, VK_HOME = 0x24, VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28, VK_INSERT = 0x2D,
    VK_DELETE = 0x2E, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_NUMPAD0 = 0x60, VK_NUMPAD9 = 0x69, VK_DECIMAL = 0x6E, VK_F1 = 0x70,
    VK_F9 = 0x78, VK_F10 = 0x79, VK_F11 = 0x7A, VK_F12 = 0x7B, VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2,
    VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5, VK_OEM_PERIOD = 0xBE,
};

static inline unsigned long long GetTickCount64()
{
    using namespace std::chrono;
    return (unsigned long long)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
static inline DWORD GetTickCount() { return (DWORD)GetTickCount64(); }
static inline void Sleep(DWORD ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
static inline void YieldProcessor() {}

// a key's state as the page last wrote it; the generic Shift, Ctrl and Alt are either side's
static inline short GetAsyncKeyState(int vk)
{
    const HostInput &in = host_input();
    vk &= 255;
    bool down = in.keys[vk] != 0;
    if (vk == VK_SHIFT) down = down || in.keys[VK_LSHIFT] || in.keys[VK_RSHIFT];
    if (vk == VK_CONTROL) down = down || in.keys[VK_LCONTROL] || in.keys[VK_RCONTROL];
    if (vk == VK_MENU) down = down || in.keys[VK_LMENU] || in.keys[VK_RMENU];
    if (vk == VK_LBUTTON) down = (in.mouse_buttons & 1) != 0;
    if (vk == VK_RBUTTON) down = (in.mouse_buttons & 2) != 0;
    if (vk == VK_MBUTTON) down = (in.mouse_buttons & 4) != 0;
    return down ? (short)0x8000 : 0;
}
static inline short GetKeyState(int vk)
{
    if (vk == VK_CAPITAL) return host_input().caps_lock ? 1 : 0;
    return GetAsyncKeyState(vk);
}

// debug-only: thread pinning, priorities, cycle counts
static inline HANDLE GetCurrentThread() { return nullptr; }
static inline HANDLE GetCurrentProcess() { return nullptr; }
static inline BOOL SetPriorityClass(HANDLE, DWORD) { return TRUE; }
static inline BOOL SetThreadPriority(HANDLE, int) { return TRUE; }
static inline DWORD_PTR SetThreadAffinityMask(HANDLE, DWORD_PTR) { return 1; }
static inline BOOL CloseHandle(HANDLE) { return TRUE; }
// HP2_QUIETCORE's core holder: not started outside Windows
static inline HANDLE CreateThread(void *, size_t, DWORD (*)(LPVOID), LPVOID, DWORD, DWORD *) { return nullptr; }
static inline BOOL TerminateProcess(HANDLE, unsigned code) { fflush(nullptr); _exit((int)code); }
static inline BOOL QueryThreadCycleTime(HANDLE, ULONG64 *cycles)
{
    using namespace std::chrono;
    *cycles = (ULONG64)duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count() * 3;   // as if 3 GHz
    return TRUE;
}
union LARGE_INTEGER {
    long long QuadPart;
};
static inline BOOL QueryPerformanceFrequency(LARGE_INTEGER *f) { f->QuadPart = 1000000000LL; return TRUE; }
static inline BOOL QueryPerformanceCounter(LARGE_INTEGER *t)
{
    using namespace std::chrono;
    t->QuadPart = (long long)duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count();
    return TRUE;
}
static inline void *GetModuleHandleA(const char *) { return nullptr; }
static inline void *GetModuleHandleW(const wchar_t *) { return nullptr; }
#endif
