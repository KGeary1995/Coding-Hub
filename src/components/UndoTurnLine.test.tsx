import { describe, expect, it } from 'vitest';
import { undoQuestion } from './UndoTurnLine';

describe('Undo last turn on a tile', () => {
  it('asks in plain words with the number of files and the other agents in the folder', () => {
    expect(undoQuestion(2, false, { files: 5, others: [] })).toBe("Put the files back as they were before CH2's last turn? 5 files change.");
    expect(undoQuestion(1, false, { files: 1, others: ['CH3'] })).toBe("Put the files back as they were before CH1's last turn? 1 file changes. CH3 also works in this folder; its changes go back too.");
    expect(undoQuestion(1, true, { files: 2, others: ['CH2', 'CH4'] })).toBe('Put the files back as they were before the undo? 2 files change. CH2 and CH4 also work in this folder; their changes go back too.');
  });
});
