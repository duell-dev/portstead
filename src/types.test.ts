import { describe as suite, it, expect } from 'vitest';
import { escapeHtml, decodeFrame, describe, defaultTarget } from './types';
suite('profile content and native desktop frames', () => {
  it('escapes untrusted names and commands before displaying markup', () => {
    expect(escapeHtml('<img src=x onerror="run()">')).toBe('&lt;img src=x onerror=&quot;run()&quot;&gt;');
  });
  it('validates binary frame sizes', () => {
    const frame = new ArrayBuffer(16); const h = new DataView(frame); h.setBigUint64(0, 9n, true); h.setUint16(8, 1, true); h.setUint16(10, 1, true);
    new Uint8Array(frame).set([20, 40, 60, 255], 12);
    expect(decodeFrame(frame)?.sequence).toBe(9); expect(decodeFrame(frame)?.pixels[3]).toBe(255);
    expect(() => decodeFrame(frame.slice(0, 15))).toThrow('Invalid desktop frame size');
    expect(decodeFrame(new ArrayBuffer(0))).toBeNull();
  });
  it('shows an explicit cluster and namespace and uses secure WinRM defaults', () => {
    expect(describe({ protocol: 'kubernetes', source: 'config', context: 'production', namespace: 'payments' })).toBe('production · payments');
    expect(defaultTarget('winrm')).toMatchObject({ tls: true, port: 5986 });
  });
});
