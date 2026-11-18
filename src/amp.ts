/** AMP web push bileşeninin beklediği yapılandırma (amp-web-push). */
export function ampWebPushConfig(input: { helperFrame: string; permissionDialog: string; serviceWorker: string }) {
  return {
    'helper-iframe-url': input.helperFrame,
    'permission-dialog-url': input.permissionDialog,
    'service-worker-url': input.serviceWorker,
  };
}

/** Sayfaya eklenecek amp-web-push öğesi. Betik Pushizo worker yolunu gösterir. */
export function ampWebPushElement(input: { helperFrame: string; permissionDialog: string; serviceWorker: string }): string {
  const config = ampWebPushConfig(input);
  return `<amp-web-push layout="nodisplay" helper-iframe-url="${config['helper-iframe-url']}" permission-dialog-url="${config['permission-dialog-url']}" service-worker-url="${config['service-worker-url']}"></amp-web-push>`;
}
