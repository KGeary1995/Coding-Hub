/**
 * Trace's main process, or with --screen-service the background service that shares this Windows computer's screen
 * with linked computers while Trace is closed (screen-service.ts). Each loads only its own code.
 */
if (process.argv.includes('--screen-service')) require('./screen-service');
else require('./main');
