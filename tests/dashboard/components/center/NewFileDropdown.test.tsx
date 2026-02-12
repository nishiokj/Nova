import { act, fireEvent, render } from '@testing-library/react';
import { NewFileDropdown } from '@/components/center/NewFileDropdown';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';

function createWorkspace(): MarkdownWorkspace {
  return {
    state: {
      tree: [
        { type: 'folder', name: 'docs', path: 'docs', children: [] },
      ],
      newFileDropdownOpen: true,
      newFileIntent: 'save',
      newFileDefaultFolder: '',
      activeRoot: '.cockpit/scratch',
      roots: [
        {
          id: '.cockpit/scratch',
          kind: 'scratch',
          label: 'Scratch',
          path: '.cockpit/scratch',
        },
      ],
    },
    closeNewFilePicker: vi.fn(),
    set: vi.fn(),
    createFileInFolder: vi.fn().mockResolvedValue(undefined),
    setActiveRoot: vi.fn().mockResolvedValue(undefined),
  } as unknown as MarkdownWorkspace;
}

describe('NewFileDropdown focus behavior', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the top root selector when opened', () => {
    render(<NewFileDropdown workspace={createWorkspace()} />);
    const rootSelector = document.querySelector('[data-new-file-root-select="true"]');
    expect(rootSelector).toBeInstanceOf(HTMLSelectElement);
    expect(document.activeElement).toBe(rootSelector);
  });

  it('keeps tab focus cycling inside the popup', () => {
    render(<NewFileDropdown workspace={createWorkspace()} />);
    const dropdown = document.querySelector('[data-new-file-dropdown="true"]') as HTMLDivElement;
    expect(dropdown).toBeTruthy();

    const getFocusable = () => Array.from(
      dropdown.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    const focusable = getFocusable();
    expect(focusable.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(focusable[0]);

    const last = focusable[focusable.length - 1];
    act(() => {
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab', bubbles: true });
    });
    expect(document.activeElement).toBe(focusable[0]);

    act(() => {
      focusable[0].focus();
      fireEvent.keyDown(focusable[0], { key: 'Tab', shiftKey: true, bubbles: true });
    });
    expect(document.activeElement).toBe(last);
  });
});
