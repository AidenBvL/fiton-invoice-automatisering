/* Version numbers, compared the way Chrome does: a list of numbers, left to
   right, not text. "9.9.0" is older than "9.20.0" — sorting them as text says
   the opposite, which is exactly the mistake that leaves someone on an old
   build thinking they are up to date.

   Shared by the service worker, the popup and the settings page. */

(function (root) {
  'use strict';

  const VALID = /^\d+(\.\d+)*$/;

  const parts = v => String(v || '').trim().split('.').map(n => parseInt(n, 10) || 0);

  const isValid = v => VALID.test(String(v || '').trim());

  /* -1 = a is older, 0 = the same, 1 = a is newer. */
  function compare(a, b) {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /* Only a version that is both readable and higher counts as newer, so a
     typo in a release row can never tell the whole department to update. */
  const isNewer = (candidate, current) =>
    isValid(candidate) && isValid(current) && compare(candidate, current) > 0;

  root.FitonVersion = { compare, isNewer, isValid };
})(typeof self !== 'undefined' ? self : this);
