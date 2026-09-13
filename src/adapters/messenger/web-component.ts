import {
  IMessengerAdapter,
  IWidgetConfig,
  MessageHandler,
  WidgetMessageTypes,
} from '../../interfaces/contracts';

/**
 * Messenger adapter for Web Components / Custom Elements.
 * Uses browser CustomEvents dispatched directly to and bubbling from the DOM element.
 */
export class DOMEventMessengerAdapter implements IMessengerAdapter {
  private element: HTMLElement;
  private handlers: Set<MessageHandler> = new Set();
  private isLockedDown: boolean = false;
  private cleanupFns: Array<() => void> = [];

  constructor(element: HTMLElement) {
    if (!element || element.nodeType !== 1) {
      throw new Error('DOMEventMessengerAdapter requires a valid HTMLElement.');
    }

    this.element = element;
    this.setupListeners();
  }

  private setupListeners(): void {
    const bindEvent = (eventName: string, messageType: string) => {
      const listener = (event: Event) => {
        if (this.isLockedDown) return;

        const customEvt = event as CustomEvent;
        const detail = customEvt.detail || {};
        const payload = detail.payload !== undefined ? detail.payload : detail;
        const msgId = detail.msgId || (detail.payload && detail.payload.msgId);

        this.handlers.forEach((handler) => {
          try {
            handler(messageType, payload, msgId);
          } catch (err) {
            console.error(`[DOMEventMessengerAdapter] Error handling ${eventName}:`, err);
          }
        });
      };

      this.element.addEventListener(eventName, listener);
      this.cleanupFns.push(() => this.element.removeEventListener(eventName, listener));
    };

    // Standard widget event bindings (supporting both widget:* and lms-widget:* prefixes)
    bindEvent('widget:request-content', WidgetMessageTypes.REQUEST_CONTENT);
    bindEvent('lms-widget:request-content', WidgetMessageTypes.REQUEST_CONTENT);
    bindEvent('widget:sync-content', WidgetMessageTypes.SYNC_CONTENT);
    bindEvent('lms-widget:sync-content', WidgetMessageTypes.SYNC_CONTENT);
    bindEvent('widget:sync-height', WidgetMessageTypes.SYNC_HEIGHT);
    bindEvent('lms-widget:sync-height', WidgetMessageTypes.SYNC_HEIGHT);

    // Generic fallback events
    const genericListener = (event: Event) => {
      if (this.isLockedDown) return;
      const customEvt = event as CustomEvent;
      if (customEvt.detail && customEvt.detail.type) {
        const { type, payload, msgId } = customEvt.detail;
        this.handlers.forEach((handler) => {
          try {
            handler(type, payload, msgId);
          } catch (err) {
            console.error('[DOMEventMessengerAdapter] Error handling generic message:', err);
          }
        });
      }
    };
    this.element.addEventListener('widget:message', genericListener);
    this.element.addEventListener('lms-widget:message', genericListener);
    this.cleanupFns.push(() => {
      this.element.removeEventListener('widget:message', genericListener);
      this.element.removeEventListener('lms-widget:message', genericListener);
    });
  }

  /**
   * Pushes initial data and configuration down to the web component.
   * Emits both host:load-content (Host-to-Guest protocol) and widget:load-content.
   */
  public sendLoadContent(content: string, config: IWidgetConfig): void {
    if (this.isLockedDown) return;

    const detail = { content, payload: content, config };

    this.element.dispatchEvent(
      new CustomEvent('host:load-content', {
        detail,
        bubbles: true,
        composed: true,
      })
    );

    this.element.dispatchEvent(
      new CustomEvent('widget:load-content', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  public sendInsertContent(content: string): void {
    if (this.isLockedDown) return;

    const detail = { content, payload: content };

    const hostEvt = new CustomEvent('host:insert-content', {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.element.dispatchEvent(hostEvt);

    const widgetEvt = new CustomEvent('widget:insert-content', {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.element.dispatchEvent(widgetEvt);

    // Native Fallback: If neither event was preventDefault'd, and the element is or contains
    // an editable textarea or text input, automatically insert content at the cursor and fire 'input'.
    if (!hostEvt.defaultPrevented && !widgetEvt.defaultPrevented) {
      const tag = this.element.tagName?.toLowerCase();
      let target: (HTMLTextAreaElement | HTMLInputElement) | null = null;
      if (tag === 'textarea' || tag === 'input') {
        target = this.element as HTMLTextAreaElement | HTMLInputElement;
      } else {
        target = this.element.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
      }

      if (target && !target.disabled && !target.readOnly) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        const val = target.value;
        target.value = val.substring(0, start) + content + val.substring(end);
        target.selectionStart = target.selectionEnd = start + content.length;
        target.focus?.();
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  /**
   * Confirms a successful save back to the web component.
   */
  public sendSyncAck(msgId: string, serverHash: string): void {
    if (this.isLockedDown) return;

    const detail = { msgId, serverHash, hash: serverHash, success: true };

    this.element.dispatchEvent(
      new CustomEvent('host:sync-ack', {
        detail,
        bubbles: true,
        composed: true,
      })
    );

    this.element.dispatchEvent(
      new CustomEvent('widget:sync-ack', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
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
      const detail = { message: 'Connection severed due to fatal sync error.' };
      this.element.dispatchEvent(
        new CustomEvent('host:lockdown', {
          detail,
          bubbles: true,
          composed: true,
        })
      );
      this.element.dispatchEvent(
        new CustomEvent('widget:lockdown', {
          detail,
          bubbles: true,
          composed: true,
        })
      );
    } catch {
      // Best effort notification
    }

    this.isLockedDown = true;
    this.handlers.clear();

    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
  }

  /**
   * Cleanup lifecycle method to unbind event listeners and prevent memory leaks.
   */
  public destroy(): void {
    this.handlers.clear();
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
  }
}

// Export alias for consistency with filename
export { DOMEventMessengerAdapter as WebComponentMessengerAdapter };
