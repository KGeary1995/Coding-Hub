import type { CSSProperties } from 'react';
import type { ChannelEngine } from '../../../shared/types';
import { useAgentLook } from '../../state/agent-store';
import { ENGINE_ICONS } from './engine-icons';

/** A channel's avatar: the engine's mark, or a custom agent's initials on its own colour (docs/custom-agents.md). */
export function EngineAvatar({ engine, agentId, size = 'small', className = '', title }: { engine: ChannelEngine; agentId?: string; size?: 'small' | 'large' | ''; className?: string; title?: string }) {
  if (engine === 'custom' && agentId) return <AgentAvatar agentId={agentId} size={size} className={className} title={title} />;
  const Icon = ENGINE_ICONS[engine];
  return <span className={`${className} ui-avatar ${size} ${engine}`.trim()} title={title} aria-hidden="true"><Icon /></span>;
}
function AgentAvatar({ agentId, size, className, title }: { agentId: string; size: string; className: string; title?: string }) {
  const look = useAgentLook(agentId);
  return <span className={`${className} ui-avatar ${size} custom`.trim()} style={{ '--tone': look.color } as CSSProperties} title={title} aria-hidden="true">{look.initials}</span>;
}
