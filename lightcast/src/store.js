export const MAX_HISTORY = 50;
let n = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

export const initialProject = () => ({
  sources: [],
  scenes: [{ id: uid('scn'), name: 1, layers: [] }],
});

// Undo/Redo: the project is immutable, so each snapshot shares structure with
// its neighbours and 50 levels cost very little memory.
export function historyReducer(state, action) {
  const { past, present, future } = state;
  switch (action.type) {
    case 'edit': {
      const next = action.fn(present);
      if (next === present) return state;
      return { past: [...past, present].slice(-MAX_HISTORY), present: next, future: [] };
    }
    case 'checkpoint':
      return { past: [...past, present].slice(-MAX_HISTORY), present, future: [] };
    case 'load':
      return { past: [], present: action.present, future: [] };
    case 'patch':
      return { ...state, present: action.fn(present) };
    case 'undo':
      if (!past.length) return state;
      return { past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future] };
    case 'redo':
      if (!future.length) return state;
      return { past: [...past, present], present: future[0], future: future.slice(1) };
    default:
      return state;
  }
}
