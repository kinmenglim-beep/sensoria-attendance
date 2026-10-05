'use strict';

(() => {
  const btn = document.querySelector('[data-use-location]');
  if (!btn) return;
  const form = btn.closest('form');
  const status = form.querySelector('[data-form-status]');
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) { status.textContent = 'This browser cannot share location.'; return; }
    status.textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition((pos) => {
      form.querySelector('[data-lat]').value = pos.coords.latitude.toFixed(6);
      form.querySelector('[data-lng]').value = pos.coords.longitude.toFixed(6);
      status.textContent = `Got it (accuracy ±${Math.round(pos.coords.accuracy)} m).`;
    }, () => { status.textContent = 'Could not get location. Check location permission.'; },
    { enableHighAccuracy: true, timeout: 20000 });
  });
})();
