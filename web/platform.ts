// One reading of the reader's platform, shared by the shortcut label and the home
// copy. navigator.platform is deprecated; Chromium exposes the replacement on
// navigator.userAgentData, which Safari and Firefox still omit. Read the newer
// field first and keep the older one as the fallback, so both spellings of an
// Apple device ("macOS"/"iOS" and "MacIntel") produce the same interface.
// The typings for userAgentData are not in this TypeScript's DOM library.
import { platformKind, type Platform } from '../src/browser.js';

interface UserAgentData { platform?: string }
const reported = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData?.platform;
export const platform: Platform = platformKind(reported ?? navigator.platform);

// Apple keyboards carry Command; everything else pairs Control with K.
export const shortcut = platform === 'other' ? 'Ctrl K' : '⌘K';
// Name the machine only where the copy is accurate: the folder chooser opens on the
// machine Rho runs on, which a Mac reader can call this Mac.
export const onPlatform = platform === 'macos' ? 'this Mac' : 'this computer';
