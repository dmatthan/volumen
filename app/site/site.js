// volumen.page's own script (the page and the privacy page). Two things only:
// - a link meant for the app (a shared book, an invitation, an opened file) arriving here,
//   and an app installed from here before the app moved to /read, go on to the app at
//   once, before anything is drawn;
// - installing: the device is named on the install button, with its mark, and the
//   install section says how, for it (without the script, a general word and a list).
//   Add to Home Screen and Add to Dock are done from the library itself (/read), so the
//   app, not this page, is what is installed.
(() => {
  const forApp = () => /^#(b|open|invite)=/.test(location.hash);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (forApp() || (installed && location.pathname === '/')) { location.replace('/read' + location.hash); return; }
  // (and one pasted into the address bar while this page is open: only its fragment changes)
  addEventListener('hashchange', () => { if (forApp()) location.replace('/read' + location.hash); });

  // the browser's own install (Chrome, Edge), offered when it can be
  let deferred = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; show(); });
  addEventListener('appinstalled', () => { deferred = null; show(); });
  async function install() {
    if (!deferred) return false;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null; show();
    return true;
  }

  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || touchMac;
  const device = ios ? (/iPad/.test(ua) || touchMac ? 'ipad' : 'iphone')
    : /Android/.test(ua) ? 'android'
    : /Macintosh/.test(ua) ? 'mac'
    : /Windows/.test(ua) ? 'windows'
    : /Linux|X11|CrOS/.test(ua) ? 'linux' : null;
  const firefox = /Firefox\//.test(ua) && !ios;
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !ios;
  const NAME = { iphone: 'iPhone', ipad: 'iPad', android: 'Android', mac: 'Mac', windows: 'Windows', linux: 'Linux' };
  const WHERE = { iphone: 'iPhone', ipad: 'iPad', android: 'Android device', mac: 'Mac', windows: 'Windows computer', linux: 'Linux computer' };
  const MARK = { iphone: 'apple', ipad: 'apple', android: 'android', mac: 'apple', windows: 'windows', linux: 'linux' };

  /** What to say for this device and browser. */
  function how() {
    const appOwn = 'It then opens in a window of its own and reads offline.';
    if (ios) return `Open the library in Safari, then tap Share and choose Add to Home Screen. ${appOwn}`;
    if (firefox) return 'Firefox does not install web apps: Volumen works in a tab here, or installs from Chrome or Edge. The desktop app is coming.';
    if (deferred) return `Install it from the browser as an app of its own. ${appOwn}`;
    if (device === 'android') return `In Chrome, open the library and choose Install app from the menu. ${appOwn}`;
    if (device === 'mac' && !chromium) return `Open the library in Safari, then choose File, Add to Dock. ${appOwn}`;
    if (chromium) return `Open the library and use the install button at the right of the address bar. ${appOwn}`;
    return null;
  }

  function mark(svg, os) {
    if (!svg) return;
    svg.querySelector('use').setAttribute('href', '#os-' + os);
    // (an SVG element has no `hidden` property: the attribute itself goes)
    svg.removeAttribute('hidden');
  }

  function show() {
    const $ = id => document.getElementById(id);
    if (!$('here-h')) return;
    // the button at the top: this device, its mark; the browser's install where offered
    const top = $('install-btn');
    if (top && device) {
      top.querySelector('span').textContent = `Install on ${NAME[device]}`;
      mark(top.querySelector('svg'), MARK[device]);
      top.onclick = async e => { if (deferred) { e.preventDefault(); await install(); } };
    }
    const text = how();
    if (device) $('here-h').textContent = `On this ${WHERE[device]}`;
    if (text) $('here-text').textContent = text;
    const btn = $('here-btn');
    btn.hidden = !deferred;
    if (device) mark(btn.querySelector('svg'), MARK[device]);
    btn.onclick = install;
    // without the browser's install, the library is where it is done
    $('here-open').classList.toggle('main', !deferred);
    // the desktop app for this computer first
    const desk = { mac: 'mac', windows: 'windows', linux: 'linux' }[device];
    const mine = desk && document.querySelector(`#downloads [data-os="${desk}"]`);
    if (mine) { mine.classList.add('mine'); mine.parentElement.prepend(mine); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
