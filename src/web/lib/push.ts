// Service worker registration and Web Push on this device.
import { get, post } from './api';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function registerServiceWorker(onOpen: (url: string) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  // A tapped notification for an already-open window: route inside the app instead of reloading.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'open' && e.data.url) onOpen(new URL(e.data.url).pathname);
  });
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  // iPhone and iPad only offer push to apps added to the home screen.
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== 'granted') return pushState();
  const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/account/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (e.g. before a reinstall) can't receive our pushes.
  if (sub) {
    const current = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    const wanted = keyBytes(publicKey);
    if (!current || current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await post('/account/push/subscriptions', sub.toJSON());
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await post('/account/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) throw new Error('Notifications are not on for this device.');
  await post('/account/push/test', { endpoint: sub.endpoint });
}

// On every start while signed in: re-send this device's subscription so the server copy stays
// current (one small request; the server upserts).
export async function refreshPush(): Promise<void> {
  if ((await pushState()) !== 'on') return;
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) await post('/account/push/subscriptions', sub.toJSON()).catch(() => undefined);
}

// Signing out: stop notifications here and drop the offline copy of this account's mail.
export async function forgetDevice(): Promise<void> {
  await disablePush().catch(() => undefined);
  navigator.serviceWorker?.controller?.postMessage('clear-data');
  await caches?.delete('api-v1').catch(() => undefined);
}
