import {
  IContextAdapter,
  IMessengerAdapter,
  IStorageAdapter,
  IWidgetConfig,
  RunMode,
  WidgetMessageTypes,
} from '../interfaces/contracts';
import { MoodleContextAdapter } from '../adapters/context/moodle';

export interface WidgetControllerOptions {
  config?: Partial<IWidgetConfig>;
  runMode?: RunMode;
  context?: IContextAdapter;
}

/**
 * The Maestro: Glues IStorageAdapter, IMessengerAdapter, and IContextAdapter together.
 * Manages event routing, data synchronization, fail-fast visual lockdown, and error UI.
 */
export class WidgetController {
  private mountPoint: HTMLElement;
  private storage: IStorageAdapter;
  private messenger: IMessengerAdapter;
  private context: IContextAdapter;
  private config: IWidgetConfig;
  private isErrorState: boolean = false;
  private widgetTarget: HTMLElement | null = null;

  constructor(
    mountPoint: HTMLElement,
    storage: IStorageAdapter,
    messenger: IMessengerAdapter,
    options: WidgetControllerOptions = {}
  ) {
    if (!mountPoint || mountPoint.nodeType !== 1) {
      throw new Error('WidgetController requires a valid mount point HTMLElement.');
    }

    this.mountPoint = mountPoint;
    this.storage = storage;
    this.messenger = messenger;
    this.context = options.context || new MoodleContextAdapter(this.mountPoint);

    // Detect target element (marked with [data-lms-widget] or fallback to child element)
    this.widgetTarget =
      this.mountPoint.querySelector('[data-lms-widget]') ||
      this.mountPoint.querySelector('iframe') ||
      (this.mountPoint.firstElementChild as HTMLElement) ||
      this.mountPoint;

    // Deduce runMode from environment or options
    const runMode: RunMode =
      options.runMode ||
      options.config?.runMode ||
      this.context.getRunMode();

    // Build configuration
    const isReadOnly =
      options.config?.isReadOnly !== undefined
        ? options.config.isReadOnly
        : this.storage.isReadOnly() ||
          Boolean(this.context.isReadOnly?.()) ||
          runMode === 'review' ||
          this.mountPoint.getAttribute('data-lms-readonly') === 'true';

    this.config = {
      isReadOnly,
      runMode,
      defaultCellType:
        this.mountPoint.getAttribute('data-lms-default-cell-type') ||
        undefined,
      disableInsertAll:
        this.mountPoint.getAttribute('data-lms-disable-insert-all') === 'true',
      ...options.config,
    };

    this.init();
  }

  /**
   * Updates runtime configuration and pushes updated state to widget.
   */
  public updateConfig(newConfig: Partial<IWidgetConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.messenger.sendLoadContent(this.storage.load(), this.config);
  }

  public getConfig(): IWidgetConfig {
    return this.config;
  }

  public getMountPoint(): HTMLElement {
    return this.mountPoint;
  }

  /**
   * Pushes new content into the widget from the host page.
   * Useful for "Use Starter Code" buttons outside the widget.
   */
  public setContent(content: string): boolean {
    if (this.isErrorState) {
      console.warn('[WidgetController] Cannot set content: Widget is in an error state.');
      return false;
    }
    if (this.config.isReadOnly) {
      console.warn('[WidgetController] Cannot set content: Widget is read-only.');
      return false;
    }

    // Push to the widget to update its editor
    this.messenger.sendLoadContent(content, this.config);

    // Save to local storage so it syncs with the LMS immediately
    return this.storage.save(content);
  }

  /**
   * Pushes a snippet of text to the widget to be inserted at the current cursor position.
   * Note: This does NOT save to the LMS directly. It relies on the widget to update its
   * internal state and fire a SYNC_CONTENT message back with the fully merged text.
   */
  public insertContent(content: string): boolean {
    if (this.isErrorState) {
      console.warn('[WidgetController] Cannot insert content: Widget is in an error state.');
      return false;
    }
    if (this.config.isReadOnly) {
      console.warn('[WidgetController] Cannot insert content: Widget is read-only.');
      return false;
    }

    this.messenger.sendInsertContent(content);
    return true;
  }

  private init(): void {
    this.cleanupPlaceholderUI();
    this.setupMessengerListeners();

    // Phase 1: Push initial load data to messenger
    const initialContent = this.storage.load();
    this.messenger.sendLoadContent(initialContent, this.config);

    // Watch for DOM disconnections of the storage target
    if (this.storage.onDisconnect) {
      this.storage.onDisconnect(() => {
        if (!this.isErrorState) {
          console.error('[WidgetController] Target LMS textarea was disconnected or removed from the DOM. Triggering Fatal Error State.');
          this.triggerErrorState('Target LMS answerbox was removed or disconnected from the DOM.');
        }
      });
    }
  }

  /**
   * Cleans up any loading indicators or placeholder UI within the mount point.
   */
  private cleanupPlaceholderUI(): void {
    const placeholders = this.mountPoint.querySelectorAll(
      '.lms-widget-placeholder, [data-lms-widget-placeholder]'
    );
    placeholders.forEach((el) => el.remove());
  }

  /**
   * Subscribes to events coming from the widget via the messenger adapter.
   */
  private setupMessengerListeners(): void {
    this.messenger.onMessage((type: string, payload: any, msgId?: string) => {
      if (this.isErrorState) return;

      switch (type) {
        case WidgetMessageTypes.REQUEST_CONTENT: {
          const content = this.storage.load();
          this.messenger.sendLoadContent(content, this.config);
          break;
        }

        case WidgetMessageTypes.SYNC_CONTENT: {
          this.handleSyncContent(payload, msgId);
          break;
        }

        case WidgetMessageTypes.SYNC_HEIGHT: {
          this.handleSyncHeight(payload);
          break;
        }

        default:
          break;
      }
    });
  }

  /**
   * Handles incoming SYNC_CONTENT messages from the widget.
   */
  private handleSyncContent(payload: any, directMsgId?: string): void {
    // Extract content string and optional message identifier
    let content = '';
    let msgId = directMsgId || '';

    if (typeof payload === 'string') {
      content = payload;
    } else if (payload && typeof payload === 'object') {
      content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content ?? payload);
      if (!msgId && payload.msgId) {
        msgId = payload.msgId;
      }
    }

    // Attempt save to storage
    const success = this.storage.save(content);

    if (success) {
      const serverHash = this.computeHash(content);
      this.messenger.sendSyncAck(msgId, serverHash);
    } else {
      console.error('[WidgetController] Storage save returned false. Triggering Fatal Error State.');
      const errorMsg = !this.storage.isAttached || this.storage.isAttached()
        ? 'Host rejected the write or storage verification failed.'
        : 'Target LMS answerbox was removed or disconnected from the DOM.';
      this.triggerErrorState(errorMsg);
    }
  }

  /**
   * Handles height synchronization from widgets to eliminate scrollbars.
   */
  private handleSyncHeight(payload: any): void {
    const height = typeof payload === 'number' ? payload : payload?.height;
    if (typeof height === 'number' && height > 0) {
      if (this.widgetTarget) {
        this.widgetTarget.style.height = `${height}px`;
      }
    }
  }

  /**
   * Computes a quick hash of the saved content for sync acknowledgement.
   */
  private computeHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Triggers the Fail-Fast Error State:
   * 1. Calls messenger.lockdown()
   * 2. Blurs and disables pointer events on the widget container
   * 3. Injects a prominent red warning banner
   */
  public triggerErrorState(details?: string): void {
    if (this.isErrorState) return;
    this.isErrorState = true;

    // Sever transport connection
    this.messenger.lockdown();

    // Visual lockdown on widget container
    const target = this.widgetTarget || this.mountPoint;
    target.style.pointerEvents = 'none';
    target.style.filter = 'blur(2px)';
    target.style.opacity = '0.3';
    target.style.userSelect = 'none';

    // Ensure mount point can anchor absolute overlay banner
    if (getComputedStyle(this.mountPoint).position === 'static') {
      this.mountPoint.style.position = 'relative';
    }

    // Inject red error banner
    this.injectErrorBanner(details);
  }

  /**
   * Injects the red warning banner over the blurred widget.
   */
  private injectErrorBanner(details?: string): void {
    const errorSlot = this.mountPoint.querySelector<HTMLElement>('[data-lms-error-slot]');
    if (errorSlot) {
      errorSlot.innerHTML = `<strong>Sync Error:</strong> Your progress could not be saved to the LMS. Typing has been locked to prevent data loss. ${details ? `<br>(${details})` : ''}`;
      errorSlot.style.display = 'block';
      return;
    }

    const existing = this.mountPoint.querySelector('.lms-widget-fatal-error-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.className = 'lms-widget-fatal-error-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background-color: var(--lms-widget-error-bg, #b71c1c);
      color: var(--lms-widget-error-text, #ffffff);
      padding: 20px 28px;
      border-radius: 8px;
      border: 2px solid var(--lms-widget-error-border, #ef5350);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      z-index: 10000;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      max-width: 90%;
      min-width: 280px;
    `;

    banner.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 8px;">
        <span style="font-size: 24px; margin-right: 8px;">⚠️</span>
        <strong style="font-size: 17px; letter-spacing: 0.3px;">LMS Connection Lost / Save Failed</strong>
      </div>
      <p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.4; color: var(--lms-widget-error-subtext, #ffebee);">
        Your progress could not be saved to the LMS. Typing has been locked to prevent data loss.
        ${details ? `<br><span style="font-size: 12px; opacity: 0.85;">(${details})</span>` : ''}
      </p>
      <button type="button" class="widget-reload-btn" style="
        background-color: var(--lms-widget-error-text, #ffffff);
        color: var(--lms-widget-error-bg, #b71c1c);
        border: none;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 600;
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.2s ease;
      ">
        Reload Page
      </button>
    `;

    const reloadBtn = banner.querySelector('.widget-reload-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => {
        window.location.reload();
      });
    }

    this.mountPoint.appendChild(banner);
  }

  public getIsErrorState(): boolean {
    return this.isErrorState;
  }

  /**
   * Cleanup lifecycle method to tear down the controller and its adapters.
   */
  public destroy(): void {
    if (this.storage.destroy) {
      this.storage.destroy();
    }
    if (this.messenger.destroy) {
      this.messenger.destroy();
    }
  }
}
