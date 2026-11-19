import { Asterisk, Sparkle, SquareChevronRight, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { ChannelEngine } from '../../../shared/types';

/** An engine's mark, a shape as well as a colour: the tile's avatar, the + Channel menu and every other place draw this one. */
export const ENGINE_ICONS: Record<ChannelEngine, LucideIcon> = { claude: Asterisk, codex: TerminalSquare, gemini: Sparkle, shell: SquareChevronRight };
