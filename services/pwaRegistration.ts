import { registerSW } from 'virtual:pwa-register';

/**
 * Register the service worker and return a callback to apply pending updates.
 * The `onNeedRefresh` handler is called when a new SW is waiting to activate.
 */
export function initServiceWorker(
  onNeedRefresh: () => void,
  onOfflineReady: () => void,
): { applyUpdate: () => void } {
  const updateSW = registerSW({
    onNeedRefresh() {
      onNeedRefresh();
    },
    onOfflineReady() {
      onOfflineReady();
    },
    onRegisteredSW(swUrl, registration) {
      // Check for updates every hour
      if (registration) {
        setInterval(() => {
          registration.update();
        }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.error('Service worker registration failed:', error);
    },
  });

  return {
    applyUpdate: () => updateSW(true),
  };
}
