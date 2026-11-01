// Minimal multi-page recorder: stitches rrweb events across page loads in
// sessionStorage so a whole user journey ends up in one recording.
(function () {
  const KEY = '__bugprint_events';
  const stored = JSON.parse(sessionStorage.getItem(KEY) || '[]');
  window.__bugprintEvents = stored;
  const persist = () => sessionStorage.setItem(KEY, JSON.stringify(window.__bugprintEvents));
  rrweb.record({
    emit(event) {
      window.__bugprintEvents.push(event);
      persist();
    },
    plugins: [rrwebPluginConsoleRecord.getRecordConsolePlugin({ level: ['error', 'warn'] })],
  });
  window.__bugprintDownload = function () {
    const blob = new Blob([JSON.stringify(window.__bugprintEvents)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'session.json';
    a.click();
  };
})();
