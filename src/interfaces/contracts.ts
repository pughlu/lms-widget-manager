/**
 * The deduced execution/environment state of the LMS host.
 */
export type RunMode = 'edit' | 'attempt' | 'grade' | 'review';

/**
 * Generic configuration passed down to the embedded widget.
 */
export interface IWidgetConfig {
  /** Prevents the widget from allowing user input. */
  isReadOnly: boolean;
  /** The deduced LMS host environment mode ('edit', 'attempt', 'grade', 'review'). */
  runMode: RunMode;
  /** Optional default state/cell type for editors. */
  defaultCellType?: string;
  /** UI flag for the widget to toggle mass insert actions. */
  disableInsertAll?: boolean;
  /** Allows arbitrary JSON config overriding. */
  [key: string]: unknown;
}

/**
 * Interface for deducing context, execution mode, and environment state from the host LMS.
 */
export interface IContextAdapter {
  /**
   * Deduces the current execution mode ('edit', 'attempt', 'grade', 'review').
   */
  getRunMode(): RunMode;

  /**
   * Deduces if the host environment or context mandates read-only behavior.
   */
  isReadOnly?(): boolean;
}

/**
 * Interface for reading and writing state to the host LMS database/DOM.
 */
export interface IStorageAdapter {
  /**
   * Retrieves the current state (implements crash recovery / LocalStorage checks).
   */
  load(): string;

  /**
   * Writes the state to the host DOM/database.
   * Must return false if the write was rejected or failed verification.
   */
  save(content: string): boolean;

  /**
   * Returns true if the host environment is locked (e.g. quiz submitted or past due date).
   */
  isReadOnly(): boolean;

  /**
   * Returns a unique hash or key for this specific storage instance
   * (used for LocalStorage keys and crash recovery).
   */
  getIdentifier(): string;

  /**
   * Optional methods to control visibility of host textarea for debugging.
   */
  showTextarea?(): void;
  hideTextarea?(): void;

  /**
   * Returns true if the storage target is currently attached to the live DOM.
   */
  isAttached?(): boolean;

  /**
   * Registers a callback that fires when the storage target is disconnected or deleted from the DOM.
   */
  onDisconnect?(callback: () => void): void;

  /**
   * Cleanup lifecycle method to unbind event listeners and prevent memory leaks.
   */
  destroy?(): void;
}

/**
 * Message handler callback signature for receiving messages from widgets.
 */
export type MessageHandler = (type: string, payload: any, msgId?: string) => void;

/**
 * Interface handling the transport layer between host and widget.
 */
export interface IMessengerAdapter {
  /**
   * Pushes initial data and configuration to the widget.
   */
  sendLoadContent(content: string, config: IWidgetConfig): void;

  /**
   * Pushes a snippet of content to be inserted at the widget's current cursor position.
   */
  sendInsertContent(content: string): void;

  /**
   * Confirms a successful save back to the widget.
   */
  sendSyncAck(msgId: string, serverHash: string): void;

  /**
   * Subscribes to widget events (REQUEST_CONTENT, SYNC_CONTENT, SYNC_HEIGHT).
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Severs the connection permanently (used during fatal errors).
   */
  lockdown(): void;

  /**
   * Cleanup lifecycle method to unbind event listeners and prevent memory leaks.
   */
  destroy?(): void;
}

/**
 * Standard event message types between LMS Widget Manager and widgets.
 */
export const WidgetMessageTypes = {
  REQUEST_CONTENT: 'REQUEST_CONTENT',
  SYNC_CONTENT: 'SYNC_CONTENT',
  SYNC_HEIGHT: 'SYNC_HEIGHT',
  LOAD_CONTENT: 'LOAD_CONTENT',
  INSERT_CONTENT: 'INSERT_CONTENT',
  SYNC_ACK: 'SYNC_ACK',
  ERROR_LOCKDOWN: 'ERROR_LOCKDOWN',
  WIDGET_READY: 'WIDGET_READY',
} as const;

export type WidgetMessageType = (typeof WidgetMessageTypes)[keyof typeof WidgetMessageTypes];
