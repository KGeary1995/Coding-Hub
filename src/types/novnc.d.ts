/** The part of noVNC's RFB client Trace uses (the package ships no types). */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { credentials?: { username?: string; password?: string }; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
    disconnect(): void;
  }
}
