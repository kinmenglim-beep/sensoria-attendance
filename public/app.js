'use strict';

// Small progressive enhancements shared by all pages.
document.addEventListener('DOMContentLoaded', () => {
  // "Select all" checkbox in approval tables.
  document.querySelectorAll('[data-select-all]').forEach((master) => {
    const form = master.closest('form');
    master.addEventListener('change', () => {
      form.querySelectorAll('input[name="ids"]').forEach((cb) => { cb.checked = master.checked; });
    });
  });

  // Confirmation prompts on destructive buttons.
  document.querySelectorAll('[data-confirm]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (!window.confirm(btn.dataset.confirm)) e.preventDefault();
    });
  });

  // Date pickers that navigate as soon as a date is chosen.
  document.querySelectorAll('[data-autosubmit]').forEach((input) => {
    input.addEventListener('change', () => input.form.submit());
  });

  // Live "time worked so far" counters.
  const timers = document.querySelectorAll('[data-elapsed-since]');
  const clock = document.querySelector('[data-clock]');
  const tick = () => {
    timers.forEach((el) => {
      const mins = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.elapsedSince)) / 60000));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      el.textContent = h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    });
    if (clock) {
      try {
        clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: clock.dataset.clock || undefined });
      } catch {
        clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }
  };
  if (timers.length || clock) { tick(); setInterval(tick, 15000); }
});
