/*
 * trace-jobs: the background runner's Windows helper (docs/background-runner.md, step 5). It puts each channel's
 * program in a job object, and stopping the channel ends the whole job, so a child that left its parent's process
 * tree (where taskkill /T no longer finds it) still ends with the channel.
 *
 * One line per request on stdin, one answer per line on stdout:
 *   add <key> <pid>   the program <pid> and everything it starts from now on join job <key>   -> ok <key> | err <key> <code>
 *   kill <key>        ends every process in job <key>                                           -> ok <key> | err <key> <code>
 *   drop <key>        forgets job <key> (its program ended)                                     -> ok <key>
 * Jobs are not set to end their processes when this helper closes: a fault here must never stop every channel.
 * It exits when stdin closes (the runner went away).
 *
 * Build: cl /nologo /O2 /W4 trace-jobs.c /Fe:trace-jobs.exe (scripts/build-jobs-helper.cjs).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define MAX_JOBS 256
static unsigned long keys[MAX_JOBS];
static HANDLE jobs[MAX_JOBS];

static int find(unsigned long key) { for (int i = 0; i < MAX_JOBS; i++) if (jobs[i] && keys[i] == key) return i; return -1; }
static int slot(void) { for (int i = 0; i < MAX_JOBS; i++) if (!jobs[i]) return i; return -1; }
static void answer(const char *word, unsigned long key, DWORD code) {
  if (code) printf("%s %lu %lu\n", word, key, (unsigned long)code); else printf("%s %lu\n", word, key);
  fflush(stdout);
}

int main(void) {
  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    char verb[16] = { 0 }; unsigned long key = 0, pid = 0;
    int fields = sscanf_s(line, "%15s %lu %lu", verb, (unsigned)sizeof verb, &key, &pid);
    if (fields < 2) continue;
    if (strcmp(verb, "add") == 0 && fields == 3) {
      int at = find(key); if (at < 0) at = slot();
      if (at < 0) { answer("err", key, ERROR_TOO_MANY_OPEN_FILES); continue; }
      HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, (DWORD)pid);
      if (!process) { answer("err", key, GetLastError()); continue; }
      HANDLE job = jobs[at] ? jobs[at] : CreateJobObjectW(NULL, NULL);
      if (!job) { answer("err", key, GetLastError()); CloseHandle(process); continue; }
      if (!AssignProcessToJobObject(job, process)) { DWORD code = GetLastError(); CloseHandle(process); if (!jobs[at]) CloseHandle(job); answer("err", key, code); continue; }
      CloseHandle(process); jobs[at] = job; keys[at] = key; answer("ok", key, 0);
    } else if (strcmp(verb, "kill") == 0) {
      int at = find(key);
      if (at < 0) { answer("err", key, ERROR_NOT_FOUND); continue; }
      if (!TerminateJobObject(jobs[at], 1)) { answer("err", key, GetLastError()); continue; }
      answer("ok", key, 0);
    } else if (strcmp(verb, "drop") == 0) {
      int at = find(key); if (at >= 0) { CloseHandle(jobs[at]); jobs[at] = NULL; }
      answer("ok", key, 0);
    }
  }
  return 0;
}
