/* ============================================================
   Deck plumbing that is not about the API: keep typing out of the
   slide navigation, and tell the live module which slide is on.
   ============================================================ */
(function () {
  'use strict';

  // The template turns Space and the arrow keys into slide changes, listening
  // on document. A search box needs both, so key presses that start in a form
  // field stop at the deck container and never reach that listener. Bubble
  // phase on purpose: the field's own handlers (Enter, arrows in a list) still run.
  var deck = document.getElementById('deck');
  if (deck) {
    deck.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) e.stopPropagation();
    });
  }

  // The template keeps goToSlide private; it flips the .active class. Watching
  // that class is the supported way to know a slide came on.
  function announce(el) {
    window.dispatchEvent(new CustomEvent('deck:slide', { detail: { el: el } }));
  }
  var slides = document.querySelectorAll('.slide');
  var obs = new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      if (m.target.classList.contains('active') && m.oldValue.indexOf('active') < 0) announce(m.target);
    });
  });
  slides.forEach(function (s) { obs.observe(s, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }); });

  // Jump by slide number through the template's public nav dots.
  window.deckJumpTo = function (n) {
    var dots = document.querySelectorAll('#navDots .nav-dot');
    if (dots[n - 1]) dots[n - 1].click();
  };
  window.deckSlideOf = function (el) {
    var s = el.closest('.slide');
    return s ? Array.prototype.indexOf.call(slides, s) + 1 : 0;
  };
})();
