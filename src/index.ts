import { IStorageAdapter, IMessengerAdapter } from './interfaces/contracts';
import { MoodleTextareaAdapter } from './adapters/storage/moodle-textarea';
import { IframeMessengerAdapter } from './adapters/messenger/iframe';
import { DOMEventMessengerAdapter } from './adapters/messenger/web-component';
import { WidgetController } from './core/widget-controller';
import { MoodleContextAdapter } from './adapters/context/moodle';

// Re-export all contracts and adapters for external consumers
export * from './interfaces/contracts';
export { MoodleTextareaAdapter } from './adapters/storage/moodle-textarea';
export { IframeMessengerAdapter } from './adapters/messenger/iframe';
export { DOMEventMessengerAdapter, WebComponentMessengerAdapter } from './adapters/messenger/web-component';
export { MoodleContextAdapter } from './adapters/context/moodle';
export { WidgetController } from './core/widget-controller';

/**
 * Registry holding active WidgetController instances.
 */
export const activeControllers: WidgetController[] = [];

/**
 * Handles the initialization and dependency injection for LMS widgets on the page.
 */
export class WidgetBootstrapper {
  /**
   * Scans the DOM for uninitialized .lms-widget-container elements and instantiates dependencies.
   */
  public static bootstrap(): WidgetController[] {
    // Clean up stale local storage backups (older than 14 days)
    MoodleTextareaAdapter.garbageCollect(14);

    // Scans strictly for .lms-widget-container
    const containers = document.querySelectorAll<HTMLElement>(
      '.lms-widget-container:not([data-lms-widget-initialized])'
    );

    const controllers: WidgetController[] = [];

    containers.forEach((container) => {
      const controller = WidgetBootstrapper.initializeContainer(container);
      if (controller) {
        controllers.push(controller);
      }
    });

    return controllers;
  }

  private static initializeContainer(container: HTMLElement): WidgetController | null {
    // 1. Locate the corresponding Moodle textarea
    const targetTextarea = WidgetBootstrapper.findTargetTextarea(container);

    if (!targetTextarea) {
      console.error(
        '[LMS Widget Manager] Bootstrapper could not find target textarea for container:',
        container
      );
      WidgetBootstrapper.renderCollisionError(container, 'Target LMS textarea could not be located for this widget.');
      container.setAttribute('data-lms-widget-initialized', 'error');
      return null;
    }

    // 2. Collision Lock: Fail-Fast check for duplicate bindings
    if (targetTextarea.getAttribute('data-lms-widget-bound') === 'true') {
      console.error(
        '[LMS Widget Manager] Collision detected: Multiple widgets bound to same box!',
        targetTextarea
      );
      WidgetBootstrapper.renderCollisionError(
        container,
        'Multiple widgets bound to same box. Initialization aborted to prevent data corruption.'
      );
      container.setAttribute('data-lms-widget-initialized', 'error');
      return null;
    }

    // Claim the textarea
    targetTextarea.setAttribute('data-lms-widget-bound', 'true');
    container.setAttribute('data-lms-widget-initialized', 'true');

    // 3. Resolve Storage Adapter (respects data-lms-widget-show-answerbox for debugging)
    const showAnswerbox = container.hasAttribute('data-lms-widget-show-answerbox');

    const storage: IStorageAdapter = new MoodleTextareaAdapter(targetTextarea, {
      hideTextarea: !showAnswerbox,
    });

    // Helper function to resolve the messenger once the element with [data-lms-widget] exists
    let controllerInstance: WidgetController | null = null;
    const tryInitializeWidget = (): boolean => {
      const widgetElement = container.querySelector<HTMLElement>('[data-lms-widget]');

      if (widgetElement) {
        const messenger = WidgetBootstrapper.createMessenger(widgetElement, container);
        if (messenger) {
          // Instantiate context adapter and the Maestro
          const context = new MoodleContextAdapter(container, targetTextarea);
          controllerInstance = new WidgetController(container, storage, messenger, { context });
          
          // Wrap destroy to remove from active controllers list
          const originalDestroy = controllerInstance.destroy.bind(controllerInstance);
          controllerInstance.destroy = () => {
            originalDestroy();
            const index = activeControllers.indexOf(controllerInstance!);
            if (index > -1) {
              activeControllers.splice(index, 1);
            }
          };

          activeControllers.push(controllerInstance);
          return true; // Successfully wired up
        }
      }
      return false; // Not found yet
    };

    // 4. Attempt synchronous wire-up first
    if (tryInitializeWidget()) {
      return controllerInstance;
    }

    // 5. If not found immediately, update/create placeholder and wait via MutationObserver
    let placeholder = container.querySelector<HTMLElement>(
      '.lms-widget-placeholder, [data-lms-widget-placeholder]'
    );

    if (placeholder) {
      placeholder.innerHTML = 'Loading answer box...';
    } else {
      placeholder = document.createElement('div');
      placeholder.className = 'lms-widget-placeholder';
      placeholder.innerHTML = 'Loading answer box...';
      placeholder.style.cssText =
        'padding: 20px; text-align: center; color: #64748b; font-family: sans-serif; font-size: 14px;';
      container.appendChild(placeholder);
    }

    // Set up the patient watcher
    const observer = new MutationObserver((_mutations, obs) => {
      if (tryInitializeWidget()) {
        obs.disconnect(); // Stop watching once successfully wired up
        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }
      }
    });

    // Watch container for DOM injections
    observer.observe(container, { childList: true, subtree: true });
    
    return controllerInstance;
  }

  private static createMessenger(widgetElement: HTMLElement, container: HTMLElement): IMessengerAdapter | null {
    if (widgetElement.tagName.toLowerCase() === 'iframe') {
      let targetOrigin = '*';
      const originAttr = container.getAttribute('data-lms-widget-origin');
      
      if (originAttr) {
        targetOrigin = originAttr;
      } else if (widgetElement.hasAttribute('src')) {
        try {
          const url = new URL(widgetElement.getAttribute('src') || '', window.location.href);
          targetOrigin = url.origin;
        } catch {
          // Ignore invalid URLs
        }
      }
      return new IframeMessengerAdapter(widgetElement as HTMLIFrameElement, targetOrigin);
    }
    
    return new DOMEventMessengerAdapter(widgetElement);
  }

  private static findTargetTextarea(container: HTMLElement): HTMLTextAreaElement | null {
    // 1. Check explicit attribute selector
    const selector = container.getAttribute('data-lms-target-textarea');

    if (selector) {
      let el: Element | null = null;
      if (selector.startsWith('#')) {
        el = document.getElementById(selector.slice(1));
      }
      if (!el) {
        try {
          el = document.querySelector(selector);
        } catch {
          // If querySelector failed due to unescaped special characters (e.g. colons in Moodle IDs), try escaping
          try {
            if (window.CSS && CSS.escape) {
              const escaped = selector.replace(/#([^. >+~:[\]]+)/g, (_, id) => '#' + CSS.escape(id));
              el = document.querySelector(escaped);
            }
          } catch {
            // ignore
          }
        }
      }
      if (el && el.tagName?.toLowerCase() === 'textarea') {
        return el as HTMLTextAreaElement;
      }
    }

    // 2. Check by name attribute
    const textareaName = container.getAttribute('data-lms-textarea-name');

    if (textareaName) {
      const el = document.querySelector(`textarea[name="${textareaName}"]`);
      if (el && el.tagName?.toLowerCase() === 'textarea') {
        return el as HTMLTextAreaElement;
      }
    }

    // 3. Check inside closest Moodle question/form container
    const parentContainer =
      container.closest('.que, .form-item, .fitem, .felement, form, body') || document.body;
    
    // Find all textareas in the parent container and exclude any that belong to this widget
    const textareas = Array.from(parentContainer.querySelectorAll('textarea'));
    const targetTextarea = textareas.find((ta) => !container.contains(ta));

    if (targetTextarea && targetTextarea.tagName?.toLowerCase() === 'textarea') {
      return targetTextarea as HTMLTextAreaElement;
    }

    return null;
  }

  private static renderCollisionError(container: HTMLElement, message: string): void {
    const errorSlot = container.querySelector<HTMLElement>('[data-lms-error-slot]');
    if (errorSlot) {
      errorSlot.innerHTML = `<strong>Collision Error:</strong> ${message}`;
      errorSlot.style.display = 'block';
      return;
    }

    // Instead of wiping out container.innerHTML, inject an absolute positioned overlay
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const banner = document.createElement('div');
    banner.className = 'lms-widget-collision-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: var(--lms-widget-overlay-bg, rgba(255, 255, 255, 0.9));
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 16px 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      box-sizing: border-box;
    `;

    banner.innerHTML = `
      <div style="background-color: var(--lms-widget-error-bg, #b71c1c); color: var(--lms-widget-error-text, #ffffff); padding: 16px 20px; border-radius: 6px; border: 2px solid var(--lms-widget-error-border, #ef5350); max-width: 90%;">
        <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 6px;">
          <span style="font-size: 20px; margin-right: 8px;">⛔</span>
          <strong style="font-size: 16px;">LMS Widget Fail-Fast Collision Error</strong>
        </div>
        <p style="margin: 0; font-size: 14px;">${message}</p>
      </div>
    `;

    container.appendChild(banner);
  }
}

/**
 * Convenience export for backward compatibility and auto-run hook.
 */
export function bootstrap(): WidgetController[] {
  return WidgetBootstrapper.bootstrap();
}

// Auto-run when DOM is loaded
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bootstrap();
    });
  } else {
    // Already loaded or interactive
    bootstrap();
  }

  // Global Event Bus for Host Scripts (Decoupled Integration)
  document.addEventListener('lms-widget:insert-content', (event: Event) => {
    const customEvt = event as CustomEvent;
    const content = customEvt.detail?.content || customEvt.detail?.payload || '';
    
    console.log(`[LMS Widget Manager] Caught global 'lms-widget:insert-content' event.`);
    console.log(`[LMS Widget Manager] Active controllers found: ${activeControllers.length}`);
    
    if (content) {
      if (activeControllers.length === 0) {
        console.warn(`[LMS Widget Manager] Received insert-content, but no widgets are currently active or initialized.`);
        return;
      }

      // Smart Routing: Try to find which widget should receive this based on the button's DOM location
      const targetNode = event.target as Node;
      if (targetNode && targetNode.nodeType === 1) { // Element node
        const element = targetNode as Element;
        const questionContainer = element.closest('.que, .form-item, form');
        if (questionContainer) {
          const targetedControllers = activeControllers.filter(c => questionContainer.contains(c.getMountPoint()));
          if (targetedControllers.length > 0) {
            console.log(`[LMS Widget Manager] Smart routed insert-content to ${targetedControllers.length} widget(s) in the same question container.`);
            targetedControllers.forEach((controller) => controller.insertContent(content));
            return;
          }
        }
      }

      // Fallback: Broadcast to all active controllers
      console.log(`[LMS Widget Manager] Broadcasting insert-content to all ${activeControllers.length} widget(s).`);
      activeControllers.forEach((controller) => {
        controller.insertContent(content);
      });
    } else {
      console.warn(`[LMS Widget Manager] Received insert-content but no content payload was found in event.detail`);
    }
  });
}
