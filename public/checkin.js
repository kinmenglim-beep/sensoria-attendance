'use strict';

(() => {
  const form = document.getElementById('clock-form');
  if (!form) return;
  const status = form.querySelector('[data-form-status]');
  const button = form.querySelector('button[type="submit"]');

  const say = (msg, kind = '') => {
    status.textContent = msg;
    status.className = `form-status ${kind}`;
  };

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This browser cannot share location.'));
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        const msg = err.code === 1
          ? 'Location permission was denied. Please allow location for this site in your browser settings.'
          : 'Could not get your location. Make sure location (GPS) is turned on.';
        reject(new Error(msg));
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
  }

  // Identify this phone/browser: a saved device key plus whatever model info the browser offers.
  async function deviceInfo() {
    const info = {
      standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    };
    try { info.deviceKey = localStorage.getItem('deviceKey') || undefined; } catch { /* storage blocked */ }
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      try {
        const h = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion']);
        info.deviceModel = h.model || undefined;
        info.platformVersion = h.platformVersion || undefined;
      } catch { /* not available */ }
    }
    return info;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { action: form.dataset.action, note: form.elements.note.value };

    button.disabled = true;
    try {
      if (form.dataset.location !== 'off') {
        say('Getting your location…');
        try {
          const pos = await getPosition();
          body.lat = pos.coords.latitude;
          body.lng = pos.coords.longitude;
          body.accuracy = pos.coords.accuracy;
        } catch (err) {
          if (form.dataset.location === 'block') throw err;
          // In "flag" mode we still let them clock in; the supervisor sees a flag.
        }
      }
      Object.assign(body, await deviceInfo());
      say('Saving…');
      const res = await fetch('/api/clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      if (data.deviceKey) { try { localStorage.setItem('deviceKey', data.deviceKey); } catch { /* ignore */ } }
      say(data.message, 'success');
      setTimeout(() => window.location.reload(), 1800);
    } catch (err) {
      say(err.message || 'Network problem. Please try again.', 'error');
      button.disabled = false;
    }
  });
})();
