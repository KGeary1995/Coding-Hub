import type { ReactNode } from 'react';

/**
 * A card's longer explanation, folded under "How this works". Its own file since 1.33.2: OtherComputers imported it from
 * HubPanels, which imports OtherComputers, a circular import.
 */
export function HowThisWorks({ children }: { children: ReactNode }) { return <details className="ui-how"><summary>How this works</summary><div>{children}</div></details>; }
