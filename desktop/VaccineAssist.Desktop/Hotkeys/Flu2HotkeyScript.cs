namespace VaccineAssist.Desktop.Hotkeys;

/// <summary>
/// The page script (AddScriptToExecuteOnDocumentCreated) that applies a
/// <see cref="Flu2HotkeyPlan"/> to the cloud macro-codes page. It only
/// rewrites key presses before the page sees them (capture phase) and adds
/// "[X]"-style badges next to products whose classic underlined letter is no
/// longer their key. It never changes DOM nodes React owns (attributes and a
/// style only), and every step is wrapped so a failure leaves the plain page.
/// </summary>
public static class Flu2HotkeyScript
{
    private const string Template = @"(function () {
  try {
    if (window.top !== window) return;
    var cfg = __PLAN__;
    var busy = false;
    var disabled = false;
    function guard() {
      // The page must still underline the classic letters we rewrite to. Evidence
      // = a visible label naming exactly one known product with a different letter.
      try {
        var us = document.querySelectorAll('u.macro-hotkey');
        for (var i = 0; i < us.length; i++) {
          var p = us[i].parentElement;
          if (!p) continue;
          var txt = (p.textContent || '').toLowerCase();
          var hit = null, hits = 0;
          for (var j = 0; j < cfg.classic.length; j++) {
            if (txt.indexOf(cfg.classic[j].match) >= 0) { hit = cfg.classic[j]; hits++; }
          }
          if (hits !== 1) continue;
          if ((us[i].textContent || '').toLowerCase() !== hit.letter) {
            disabled = true;
            var why = hit.match + ' shows ' + (us[i].textContent || '') + ', expected ' + hit.letter;
            try { window.chrome.webview.postMessage({ type: 'vaccine-assist:hotkey-guard', reason: why }); } catch (e1) { }
            notice('The page hotkeys changed - the new hotkeys are off; use the underlined letters.');
            return false;
          }
        }
      } catch (err) { }
      return true;
    }
    function notice(msg) {
      var d = document.getElementById('va-hk-notice');
      if (!d) {
        d = document.createElement('div');
        d.id = 'va-hk-notice';
        d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;padding:6px 10px;background:#fff3cd;color:#7a4b00;border:1px solid #e0b252;border-radius:4px;font:14px sans-serif;z-index:99999';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = msg;
      d.style.display = 'block';
      clearTimeout(d._t);
      d._t = setTimeout(function () { d.style.display = 'none'; }, 4000);
    }
    window.addEventListener('keydown', function (e) {
      try {
        if (busy || disabled || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        var t = e.target;
        if (t && t.tagName) {
          var tag = t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
        }
        var k = (e.key || '').toLowerCase();
        if (k.length !== 1) return;
        if (cfg.blocked.indexOf(k) >= 0) { if (!guard()) return; e.stopImmediatePropagation(); e.preventDefault(); return; }
        var m = cfg.keys[k];
        if (!m) return;
        if (!m.notice && !guard()) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (m.notice) { notice(m.notice); return; }
        busy = true;
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: m.to, bubbles: true, cancelable: true }));
        } finally { busy = false; }
      } catch (err) { busy = false; }
    }, true);

    function relabel() {
      try {
        if (disabled) return;
        var us = document.querySelectorAll('u.macro-hotkey');
        for (var i = 0; i < us.length; i++) {
          var p = us[i].parentElement;
          if (!p) continue;
          var txt = (p.textContent || '').toLowerCase();
          for (var j = 0; j < cfg.relabel.length; j++) {
            if (txt.indexOf(cfg.relabel[j].match) >= 0) {
              p.setAttribute('data-va-key', cfg.relabel[j].key);
              us[i].style.textDecoration = 'none';
              break;
            }
          }
        }
      } catch (err) { }
    }
    function start() {
      try {
        var s = document.createElement('style');
        s.textContent = '[data-va-key]::after{content:"" ["" attr(data-va-key) ""]"";font-weight:600;font-size:.85em;color:#1f6feb}';
        (document.head || document.documentElement).appendChild(s);
        var timer = null;
        new MutationObserver(function () {
          if (timer) return;
          timer = setTimeout(function () { timer = null; relabel(); }, 50);
        }).observe(document.documentElement, { childList: true, subtree: true });
        relabel();
      } catch (err) { }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  } catch (err) { }
})();";

    /// <summary>The script text for <paramref name="plan"/>.</summary>
    public static string Build(Flu2HotkeyPlan plan) => Template.Replace("__PLAN__", plan.ToJson());
}
