import { describe, expect, it } from 'vitest';

import { preferredImageSrc, upgradeKnownCdnUrl } from './image-url.js';

describe('upgradeKnownCdnUrl', () => {
  it('promotes Twitter name=small to name=large', () => {
    expect(
      upgradeKnownCdnUrl(
        'https://pbs.twimg.com/media/ABC?format=jpg&name=small',
      ),
    ).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=large');
  });

  it('leaves name=large and data/blob URLs alone', () => {
    expect(
      upgradeKnownCdnUrl(
        'https://pbs.twimg.com/media/ABC?format=jpg&name=large',
      ),
    ).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=large');
    expect(upgradeKnownCdnUrl('data:image/png;base64,aaa')).toBe(
      'data:image/png;base64,aaa',
    );
    expect(upgradeKnownCdnUrl('blob:https://x.com/1')).toBe(
      'blob:https://x.com/1',
    );
  });

  it('promotes profile _normal crops to _400x400', () => {
    expect(
      upgradeKnownCdnUrl(
        'https://pbs.twimg.com/profile_images/1/face_normal.jpg',
      ),
    ).toBe('https://pbs.twimg.com/profile_images/1/face_400x400.jpg');
  });
});

describe('preferredImageSrc', () => {
  it('picks the widest srcset candidate then upgrades the CDN', () => {
    const src = preferredImageSrc({
      currentSrc: 'https://pbs.twimg.com/media/ABC?format=jpg&name=small',
      src: 'https://pbs.twimg.com/media/ABC?format=jpg&name=small',
      srcset:
        'https://pbs.twimg.com/media/ABC?format=jpg&name=small 240w, https://pbs.twimg.com/media/ABC?format=jpg&name=medium 680w, https://pbs.twimg.com/media/ABC?format=jpg&name=large 1200w',
    });
    expect(src).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=large');
  });

  it('uses data-orig-src when it is the only full URL', () => {
    const src = preferredImageSrc({
      src: '',
      getAttribute: (name) =>
        name === 'data-orig-src' ? 'https://cdn.example/full.jpg' : null,
    });
    expect(src).toBe('https://cdn.example/full.jpg');
  });
});
