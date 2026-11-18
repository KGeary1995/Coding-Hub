import { HIERARCHY_MODELS } from '../../../shared/chat';
import { modelValue } from '../../../shared/schemas';
import { isAgentConfig, type Session } from '../../../shared/types';

/**
 * A seat's model typed under a hierarchy table's Models: saved only when it is a model identifier (or blank for the
 * default), since any other text would make every later workspace save fail. Returns why it was not saved, or ''.
 * Kept out of ChatParts, which the phone also loads, so the phone does not load zod and every schema for a check it never makes.
 */
export function applySeatModel(session: Session | null | undefined, value: string, onModel: (session: Session, model: string) => void): string {
  if (!session || !isAgentConfig(session.config)) return '';
  const model = modelValue(value);
  if (model === null) return `"${value.trim().slice(0, 40)}" is not a model identifier, so it was not saved. Use one such as ${HIERARCHY_MODELS.builder}, or leave it blank for the default.`;
  onModel(session, model); return '';
}
