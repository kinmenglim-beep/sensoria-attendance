'use strict';

(() => {
  const form = document.getElementById('clock-form');
  if (!form) return;
  const status = form.querySelector('[data-form-status]');
  const button = form.querySelector('button[type="submit"]');
  const selfieInput = form.querySelector('input[name="selfie"]');
  const preview = form.querySelector('[data-selfie-preview]');
  let selfieData = null;

  const say = (msg, kind = '') => {
    status.textContent = msg;
    status.className = `form-status ${kind}`;
  };

  // Shrink the photo before upload: phone cameras produce multi-MB files.
  function compress(file, maxSize = 480, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the photo. Please try again.'));
      };
      img.src = url;
    });
  }

  if (selfieInput) {
    selfieInput.addEventListener('change', async () => {
      const file = selfieInput.files[0];
      if (!file) return;
      try {
        say('Preparing photo…');
        selfieData = await compress(file);
        preview.replaceChildren();
        const img = new Image();
        img.src = selfieData;
        img.alt = 'Your selfie';
        preview.appendChild(img);
        preview.classList.add('has-photo');
        say('');
      } catch (err) {
        selfieData = null;
        say(err.message, 'error');
      }
    });
  }

  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Step-by-step help for the two places location can be switched off: the phone, and this site.
  function howToAllow() {
    return isIos
      ? 'On iPhone: open Settings → Privacy & Security → Location Services, turn it On, tap Safari Websites and choose "While Using the App". Then come back, reload this page and try again.'
      : 'On Android: tap the icon to the left of the web address → Permissions (or Site settings) → Location → Allow. Then reload this page and try again.';
  }
  function howToTurnOn() {
    return isIos
      ? 'Make sure Location Services is On (Settings → Privacy & Security → Location Services), then try again.'
      : 'Swipe down from the top of the screen and turn on Location, then try again.';
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This browser cannot share location.'));
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        reject(new Error(err.code === 1 ? `Location is blocked for this site. ${howToAllow()}` : `Could not get your location. ${howToTurnOn()}`));
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
    if (form.dataset.selfie === 'block' && !selfieData) {
      say('Please take a selfie first (tap the camera box).', 'error');
      return;
    }
    if (selfieData) body.selfie = selfieData;

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
          // Location required: stop here so they can turn it on.
          if (form.dataset.location === 'block' || form.dataset.location === 'require') throw err;
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
