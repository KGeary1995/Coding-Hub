import '../src/tile.css';
import { createRoot } from 'react-dom/client';
import { RemoteChat, type RemoteChatProps } from '../src/components/chat/RemoteChat';
export { receiveChat, receiveReplay } from '../src/components/chat/RemoteChat';

/** Shows a chat channel on the phone in `container` (the shared RemoteChat); returns the function that removes it. */
export function mountChat(container: HTMLElement, props: RemoteChatProps) {
  const root = createRoot(container); root.render(<RemoteChat {...props} className="phone-chat" />);
  return () => root.unmount();
}
