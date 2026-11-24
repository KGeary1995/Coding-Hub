import { create } from 'zustand';

/** What the getting started guide (components/GettingStarted.tsx) sees happen while Trace is open: an agent finished a turn (it was asked something), the phone page was opened. */
export const useGuideStore = create<{ turned: boolean; phoneSeen: boolean; open: boolean }>(() => ({ turned: false, phoneSeen: false, open: true }));
export const guideTurnEnded = () => { if (!useGuideStore.getState().turned) useGuideStore.setState({ turned: true }); };
