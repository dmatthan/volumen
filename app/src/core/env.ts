/** Where the app is running, as far as it needs to know. */
import { isTauri } from './shell';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

/** Safari itself (not the desktop app's WebKit, nor Chrome or Firefox on iOS, which wrap
 *  WebKit with their own bars). */
export const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/.test(ua) && !isTauri;

/** An iPhone or iPad (an iPad says it is a Mac, with a touch screen). */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

/** Opened as an installed app (the Home Screen, the Dock), not in a browser tab. */
export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
