import { act, fireEvent, render, screen } from '@testing-library/react';
import { CockpitStoreContext, CockpitStoreImpl } from '@/hooks/use-cockpit-store';
import { MessageInput } from '@/components/center/MessageInput';

function renderWithStore(store: CockpitStoreImpl) {
  return render(
    <CockpitStoreContext.Provider value={store}>
      <MessageInput />
    </CockpitStoreContext.Provider>
  );
}

describe('MessageInput keyboard propagation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets Ctrl+S bubble to the global keyboard handler', () => {
    const store = new CockpitStoreImpl();
    renderWithStore(store);
    const textarea = screen.getByRole('textbox');
    const keydownSpy = vi.fn();
    window.addEventListener('keydown', keydownSpy);

    textarea.focus();
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true, bubbles: true });

    window.removeEventListener('keydown', keydownSpy);
    const sawCtrlS = keydownSpy.mock.calls.some(([event]) => {
      const keyboardEvent = event as KeyboardEvent;
      return keyboardEvent.key.toLowerCase() === 's' && keyboardEvent.ctrlKey;
    });
    expect(sawCtrlS).toBe(true);
  });

  it('keeps normal typing keystrokes local to the input', () => {
    const store = new CockpitStoreImpl();
    renderWithStore(store);
    const textarea = screen.getByRole('textbox');
    const keydownSpy = vi.fn();
    window.addEventListener('keydown', keydownSpy);

    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'a', bubbles: true });

    window.removeEventListener('keydown', keydownSpy);
    const sawPlainA = keydownSpy.mock.calls.some(([event]) => {
      const keyboardEvent = event as KeyboardEvent;
      return keyboardEvent.key.toLowerCase() === 'a' && !keyboardEvent.ctrlKey;
    });
    expect(sawPlainA).toBe(false);
  });

  it('reopens chat with messages drawer and messages filter when collapsed', () => {
    const store = new CockpitStoreImpl();
    act(() => {
      store.set({ inputVisible: false, eventDrawerOpen: false, eventFilter: 'all' });
    });
    renderWithStore(store);

    fireEvent.click(screen.getByRole('button', { name: /Ctrl\+` to chat/i }));

    const state = store.getSnapshot();
    expect(state.inputVisible).toBe(true);
    expect(state.eventDrawerOpen).toBe(true);
    expect(state.eventFilter).toBe('messages');
  });
});
