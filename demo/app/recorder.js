// Multi-page recorder for the demo: stitches rrweb events across page loads in
// sessionStorage so a whole user journey ends up in one recording.
import { getRecordBugprintPlugin } from '/vendor/bugprint-recorder.js';

const KEY = '__bugprint_events';
window.__bugprintEvents = JSON.parse(sessionStorage.getItem(KEY) || '[]');
const persist = () => sessionStorage.setItem(KEY, JSON.stringify(window.__bugprintEvents));

rrweb.record({
  emit(event) {
    window.__bugprintEvents.push(event);
    persist();
  },
  plugins: [
    rrwebPluginConsoleRecord.getRecordConsolePlugin({ level: ['error', 'warn'] }),
    rrwebPluginNetworkRecord.getRecordNetworkPlugin({ initiatorTypes: ['fetch', 'xmlhttprequest'], recordHeaders: true, recordBody: true }),
    getRecordBugprintPlugin(),
  ],
});

window.__bugprintDownload = function () {
  const blob = new Blob([JSON.stringify(window.__bugprintEvents)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'session.json';
  a.click();
};
