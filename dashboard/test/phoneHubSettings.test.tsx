import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSheet } from '../src/components/SettingsSheet.js';
import { DashboardStore } from '../src/store.js';
import { fakeClock } from './helpers.js';
it('explains phone-owned services and the foreground lifecycle before setup', () => {
  const store=new DashboardStore(fakeClock());
  const html=renderToStaticMarkup(<SettingsSheet store={store} nativeAvailable={false}/>);
  expect(html).toContain('Phone hub');
  expect(html).toContain('while LumenDock is open');
  expect(html).toContain('Set up phone hub');
  expect(html).not.toContain('accessToken');
  store.dispose();
});
