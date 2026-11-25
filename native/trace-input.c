/*
 * trace-input: the administrator side of Windows screen sharing (docs/plans/admin-screen-service.md, option B).
 * Windows lets only a program running as administrator send input to apps that run as administrator. Up to 1.45 the
 * scheduled task ran Trace.exe itself as administrator, from files the person's own account can change. This small
 * program is what the task runs instead, from a folder only administrators can change (Program Files\Trace Input),
 * and it does one thing: it presses the keys and moves the mouse that the screen service sends it.
 *
 * It listens on the named pipe \\.\pipe\trace-input-<name> (the name is its one argument): only this Windows user,
 * SYSTEM and Administrators may open it, and never from another computer. Each line is one of the screen service's
 * commands (screen-input.ts), checked against the same grammar as input-relay.ts's COMMAND, and nothing else is done:
 *   m <x> <y> <flags> <data>   mouse (x, y 0-65535 across the virtual desktop; SendInput's flags and wheel data)
 *   k <vk> <down> <extended>   a key by virtual-key code
 *   c <code point> <down>      a character: its key on this layout, else typed as Unicode
 * Whatever a client leaves pressed when it goes is released. A line longer than 64 characters ends that client.
 *
 * trace-input.exe --check reads lines on stdin and answers "ok" or "bad" for each (the grammar only, nothing is
 * pressed): for tests.
 *
 * Build: cl /nologo /O2 /W4 /WX trace-input.c /Fe:trace-input.exe (scripts/build-jobs-helper.cjs).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")

#define MAX_CLIENTS 4
#define MAX_LINE 64
#define MAX_HELD 64

/* One number: an optional minus sign (when `sign`), then 1 to `most` digits; advances *p past it. */
static int number(const char **p, int most, int sign, long long *out) {
  const char *s = *p; int negative = 0, count = 0; long long value = 0;
  if (sign && *s == '-') { negative = 1; s++; }
  while (*s >= '0' && *s <= '9') { if (++count > most) return 0; value = value * 10 + (*s - '0'); s++; }
  if (count == 0) return 0;
  *out = negative ? -value : value; *p = s; return 1;
}
static int bit(const char **p, long long *out) { if (**p != '0' && **p != '1') return 0; *out = **p - '0'; (*p)++; return 1; }
static int space(const char **p) { if (**p != ' ') return 0; (*p)++; return 1; }

/* The grammar of input-relay.ts's COMMAND, exactly: the parsed values go in v[0..3]. */
static int parse(const char *line, char *kind, long long v[4]) {
  const char *p = line + 1;
  if (line[0] == 'm') {
    if (!(space(&p) && number(&p, 6, 1, &v[0]) && space(&p) && number(&p, 6, 1, &v[1]) && space(&p) && number(&p, 5, 0, &v[2]) && space(&p) && number(&p, 6, 1, &v[3]))) return 0;
  } else if (line[0] == 'k') {
    if (!(space(&p) && number(&p, 3, 0, &v[0]) && space(&p) && bit(&p, &v[1]) && space(&p) && bit(&p, &v[2]))) return 0;
  } else if (line[0] == 'c') {
    if (!(space(&p) && number(&p, 7, 0, &v[0]) && space(&p) && bit(&p, &v[1]))) return 0;
  } else return 0;
  if (*p != '\0') return 0;
  *kind = line[0]; return 1;
}

static void send_one(INPUT *input) { SendInput(1, input, sizeof(INPUT)); }
static void key(WORD vk, int down, int extended) {
  INPUT input; ZeroMemory(&input, sizeof input); input.type = INPUT_KEYBOARD;
  input.ki.wVk = vk; input.ki.wScan = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC); input.ki.dwFlags = (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  send_one(&input);
}
static void unicode(WCHAR unit, int down) {
  INPUT input; ZeroMemory(&input, sizeof input); input.type = INPUT_KEYBOARD;
  input.ki.wScan = unit; input.ki.dwFlags = KEYEVENTF_UNICODE | (down ? 0 : KEYEVENTF_KEYUP);
  send_one(&input);
}
static void character(long long point, int down) {
  WCHAR units[2]; int count;
  if (point < 0 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) return;
  if (point < 0x10000) { units[0] = (WCHAR)point; count = 1; } else { point -= 0x10000; units[0] = (WCHAR)(0xD800 + (point >> 10)); units[1] = (WCHAR)(0xDC00 + (point & 0x3FF)); count = 2; }
  if (count == 1) { SHORT scan = VkKeyScanW(units[0]); if (scan != -1 && (scan & 0xff) != 0xff) { key((WORD)(scan & 0xff), down, 0); return; } }
  for (int i = 0; i < count; i++) unicode(units[i], down);
}
static void mouse(long long x, long long y, long long flags, long long data) {
  INPUT input; ZeroMemory(&input, sizeof input); input.type = INPUT_MOUSE;
  input.mi.dx = (LONG)x; input.mi.dy = (LONG)y; input.mi.dwFlags = (DWORD)flags; input.mi.mouseData = (DWORD)(LONG)data;
  send_one(&input);
}

/* What a client holds down, as input-relay.ts's trackHeld keeps it: released when the client goes. */
typedef struct { char kind; long long a, b; } Held;
typedef struct { Held items[MAX_HELD]; int count; long long x, y; } HeldSet;
static void hold(HeldSet *set, char kind, long long a, long long b, int down) {
  /* A mouse button is one entry whatever else was in its flags; a key is its code and whether it is extended. */
  for (int i = 0; i < set->count; i++) if (set->items[i].kind == kind && set->items[i].a == a && (kind == 'm' || set->items[i].b == b)) { if (down) set->items[i].b = b; else set->items[i] = set->items[--set->count]; return; }
  if (down && set->count < MAX_HELD) { set->items[set->count].kind = kind; set->items[set->count].a = a; set->items[set->count].b = b; set->count++; }
}
/* SendInput's button flags, pressed and released: left, right, middle. */
static const long long BUTTONS[3][2] = { { 0x0002, 0x0004 }, { 0x0008, 0x0010 }, { 0x0020, 0x0040 } };
static void apply(HeldSet *held, char kind, long long v[4]) {
  if (kind == 'm') {
    mouse(v[0], v[1], v[2], v[3]); held->x = v[0]; held->y = v[1];
    for (int i = 0; i < 3; i++) { if (v[2] & BUTTONS[i][0]) hold(held, 'm', BUTTONS[i][0], v[2] & ~BUTTONS[i][0], 1); else if (v[2] & BUTTONS[i][1]) hold(held, 'm', BUTTONS[i][0], 0, 0); }
  } else if (kind == 'k') { key((WORD)v[0], (int)v[1], (int)v[2]); hold(held, 'k', v[0], v[2], (int)v[1]); }
  else { character(v[0], (int)v[1]); hold(held, 'c', v[0], 0, (int)v[1]); }
}
static void release_all(HeldSet *held) {
  for (int i = 0; i < held->count; i++) {
    Held *item = &held->items[i];
    if (item->kind == 'k') key((WORD)item->a, 0, (int)item->b);
    else if (item->kind == 'c') character(item->a, 0);
    else { for (int b = 0; b < 3; b++) if (BUTTONS[b][0] == item->a) mouse(held->x, held->y, (item->b & ~item->a) | BUTTONS[b][1], 0); }
  }
  held->count = 0;
}

/* One client: its lines, checked and pressed, until it closes or sends a line that is too long. */
static DWORD WINAPI serve(LPVOID parameter) {
  HANDLE pipe = (HANDLE)parameter; char buffer[512], line[MAX_LINE + 1]; int length = 0, nul = 0; DWORD got; HeldSet held; ZeroMemory(&held, sizeof held);
  while (ReadFile(pipe, buffer, sizeof buffer, &got, NULL) && got > 0) {
    int stop = 0;
    for (DWORD i = 0; i < got && !stop; i++) {
      char ch = buffer[i];
      /* A NUL inside a line makes it no command (C would read only the part before it). */
      if (ch == '\n') { char kind; long long v[4] = { 0, 0, 0, 0 }; line[length] = '\0'; if (!nul && parse(line, &kind, v)) apply(&held, kind, v); length = 0; nul = 0; }
      else if (ch == '\0') nul = 1;
      else if (length >= MAX_LINE) stop = 1;
      else line[length++] = ch;
    }
    if (stop) break;
  }
  release_all(&held);
  DisconnectNamedPipe(pipe); CloseHandle(pipe); return 0;
}

/* The pipe's security: full access for SYSTEM, Administrators and this user only, nobody else. */
static int security(SECURITY_ATTRIBUTES *attributes) {
  HANDLE token; DWORD info[64]; DWORD size; LPWSTR sid = NULL; WCHAR sddl[256];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  int ok = GetTokenInformation(token, TokenUser, info, sizeof info, &size) && ConvertSidToStringSidW(((TOKEN_USER *)info)->User.Sid, &sid);
  CloseHandle(token); if (!ok) return 0;
  _snwprintf_s(sddl, 256, _TRUNCATE, L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;%s)", sid); LocalFree(sid);
  attributes->nLength = sizeof *attributes; attributes->bInheritHandle = FALSE;
  return ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &attributes->lpSecurityDescriptor, NULL);
}

static int check_mode(void) {
  char line[1024];
  while (fgets(line, sizeof line, stdin)) {
    size_t n = strlen(line); while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
    char kind; long long v[4]; printf("%s\n", n <= (size_t)MAX_LINE && parse(line, &kind, v) ? "ok" : "bad"); fflush(stdout);
  }
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--check") == 0) return check_mode();
  if (argc != 2) { fwprintf(stderr, L"Usage: trace-input <name> | --check\n"); return 2; }
  size_t length = wcslen(argv[1]); if (length == 0 || length > (size_t)64) return 2;
  for (size_t i = 0; i < length; i++) { wchar_t c = argv[1][i]; if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'.' || c == L'_' || c == L'-')) return 2; }
  WCHAR name[128]; _snwprintf_s(name, 128, _TRUNCATE, L"\\\\.\\pipe\\trace-input-%s", argv[1]);
  SECURITY_ATTRIBUTES attributes; if (!security(&attributes)) { fwprintf(stderr, L"trace-input: the pipe's security could not be set (%lu)\n", GetLastError()); return 1; }
  int first = 1;
  for (;;) {
    /* The first instance must be this program's own: if another program already holds the name, give up. */
    HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_INBOUND | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, MAX_CLIENTS, 0, 4096, 0, &attributes);
    if (pipe == INVALID_HANDLE_VALUE) { if (first) { fwprintf(stderr, L"trace-input: %s is taken or cannot be made (%lu)\n", name, GetLastError()); return 1; } Sleep(500); continue; }
    first = 0;
    if (!ConnectNamedPipe(pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) { CloseHandle(pipe); continue; }
    HANDLE thread = CreateThread(NULL, 0, serve, pipe, 0, NULL);
    if (thread) CloseHandle(thread); else { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
  }
}
