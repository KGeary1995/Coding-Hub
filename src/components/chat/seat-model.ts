import { HIERARCHY_MODELS } from '../../../shared/chat';
import { modelValue } from '../../../shared/schemas';

/**
 * Why text typed in a seat's model field cannot be used, or '': only a model identifier (or blank, for the CLI's
 * default) is kept, since any other text would make every later workspace save fail. The field's value goes through
 * `modelValue` to be stored. Kept out of ChatParts, which the phone also loads, so the phone does not load zod and every
 * schema for a check it never makes.
 */
export function modelProblem(value: string): string {
  if (modelValue(value) !== null) return '';
  return `"${value.trim().slice(0, 40)}" is not a model identifier. Use one such as ${HIERARCHY_MODELS.builder}, or leave it blank for the default.`;
}
