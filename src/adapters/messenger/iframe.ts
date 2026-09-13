import {
  IMessengerAdapter,
  IWidgetConfig,
  MessageHandler,
  WidgetMessageTypes,
} from '../../interfaces/contracts';

/**
 * Messenger adapter that communicates with an embedded iframe via window.postMessage.
 * Enforces strict origin and event.source validation to prevent security leaks.
 */
export class IframeMessengerAdapter implements IMessengerAdapter {
  private iframe: HTMLIFrameElement;
  private targetOrigin: string;
  private handlers: Set<MessageHandler> = new Set();
  private isLockedDown: boolean = false;
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(iframe: HTMLIFrameElement, targetOrigin: string = '*') {
    if (!iframe || iframe.tagName?.toLowerCase() !== 'iframe') {
      throw new Error('IframeMessengerAdapter requires a valid HTMLIFrameElement.');
    }

    this.iframe = iframe;
    this.targetOrigin = targetOrigin;
    this.setupListener();
  }

  private setupListener(): void {
    this.messageListener = (event: MessageEvent) => {
      if (this.isLockedDown) return;

      // Validate event source strictly against iframe's contentWindow
      if (!this.iframe.contentWindow || event.source !== this.iframe.contentWindow) {
        return;
      }

      // Check origin if targetOrigin is not wildcard
      if (this.targetOrigin !== '*' && event.origin !== this.targetOrigin) {
        return;
      }

      let data = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // Not a JSON message, ignore
          return;
        }
      }

      if (!data || typeof data !== 'object') {
        return;
      }

      const { type, payload, msgId } = data;
      if (typeof type === 'string') {
        this.handlers.forEach((handler) => {
          try {
            handler(type, payload, msgId);
          } catch (err) {
            console.error('[IframeMessengerAdapter] Error in message handler:', err);
          }
        });
      }
    };

    window.addEventListener('message', this.messageListener);
  }

  private post(message: Record<string, unknown>): void {
    if (this.isLockedDown) return;
    if (!this.iframe.contentWindow) {
      console.warn('[IframeMessengerAdapter] Cannot post message: iframe contentWindow not accessible.');
      return;
    }

    try {
      this.iframe.contentWindow.postMessage(message, this.targetOrigin);
    } catch (err) {
      console.error('[IframeMessengerAdapter] Failed to postMessage to iframe:', err);
    }
  }

  /**
   * Pushes initial data and configuration down to the widget.
   */
  public sendLoadContent(content: string, config: IWidgetConfig): void {
    this.post({
      type: WidgetMessageTypes.LOAD_CONTENT,
      payload: {
        content,
        config,
      },
    });
  }

  /**
   * Sends content insertion to the widget.
   */
  public sendInsertContent(content: string): void {
    this.post({
      type: WidgetMessageTypes.INSERT_CONTENT,
      payload: {
        content,
      },
    });
  }

  /**
   * Sends synchronization acknowledgement back to the widget.
   */
  public sendSyncAck(msgId: string, serverHash: string): void {
    this.post({
      type: WidgetMessageTypes.SYNC_ACK,
      msgId,
      payload: {
        serverHash,
        success: true,
      },
    });
  }

  /**
   * Subscribes to events emitted by the widget.
   */
  public onMessage(handler: MessageHandler): void {
    if (this.isLockedDown) return;
    this.handlers.add(handler);
  }

  /**
   * Permanently severs the connection to the widget during fatal error states.
   */
  public lockdown(): void {
    if (this.isLockedDown) return;

    try {
      this.post({
        type: WidgetMessageTypes.ERROR_LOCKDOWN,
        payload: { message: 'Connection severed due to fatal sync error.' },
      });
    } catch {
      // Best effort notification before lockdown
    }

    this.isLockedDown = true;
    this.handlers.clear();

    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
  }

  /**
   * Cleanup lifecycle method to unbind event listeners and prevent memory leaks.
   */
  public destroy(): void {
    this.handlers.clear();
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
  }
}
