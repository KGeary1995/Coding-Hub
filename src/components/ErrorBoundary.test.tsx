import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary } from './ErrorBoundary';

describe('a view that fails to draw', () => {
  it('is caught and said in place, with Try again, instead of blanking the window', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('input is undefined'))).toEqual({ error: new Error('input is undefined') });
    expect(ErrorBoundary.getDerivedStateFromError('thrown text').error.message).toBe('thrown text');
    const boundary = new ErrorBoundary({ label: 'Channel 2', children: <p>tile</p> });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>tile</p>');
    boundary.state = { error: new Error('input is undefined') };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('role="alert"'); expect(html).toContain('Channel 2 could not be shown.'); expect(html).toContain('input is undefined'); expect(html).toContain('Try again');
  });
  it('draws again when the view shown changes', () => {
    const boundary = new ErrorBoundary({ label: 'This view', resetKey: 'tasks', children: null });
    boundary.state = { error: new Error('x') }; const setState = vi.spyOn(boundary, 'setState').mockImplementation(() => {});
    boundary.componentDidUpdate({ resetKey: 'tasks' }); expect(setState).not.toHaveBeenCalled();
    boundary.componentDidUpdate({ resetKey: 'usage' }); expect(setState).toHaveBeenCalledWith({ error: null });
  });
});
