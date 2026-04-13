/**
 * Pixel-faithful mockup of the redesigned book detail hero section.
 * Shows three variants side by side:
 *   A) Open Library cover  → warm ivory glow
 *   B) Google Books cover  → cool white-blue glow
 *   C) No cover (typographic fallback) → warm glow (OL default)
 */

const HERO_GRADIENT = 'linear-gradient(to bottom, #f4f0eb 0%, #eee9e2 100%)';
const OVERLAY_COLOR = 'rgba(124, 110, 90, 0.045)';

const GLOW_OL_INNER = 'rgba(255, 238, 195, 0.68)';
const GLOW_OL_OUTER = 'rgba(255, 245, 218, 0.28)';
const GLOW_GB_INNER = 'rgba(220, 232, 252, 0.72)';
const GLOW_GB_OUTER = 'rgba(230, 240, 255, 0.30)';

const PAGE_BG = '#f5f1ec';

type HeroVariant = {
  label: string;
  provider: 'ol' | 'gb' | 'none';
  coverUrl: string | null;
  title: string;
  author: string;
  initials: string;
};

const VARIANTS: HeroVariant[] = [
  {
    label: 'Open Library cover (warm glow)',
    provider: 'ol',
    coverUrl: 'https://covers.openlibrary.org/b/olid/OL7353617M-M.jpg',
    title: 'The Night Circus',
    author: 'Erin Morgenstern',
    initials: 'TN',
  },
  {
    label: 'Google Books cover (cool glow)',
    provider: 'gb',
    coverUrl: 'https://books.google.com/books/content?id=someId&printsec=frontcover&img=1&zoom=1',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    initials: 'PH',
  },
  {
    label: 'No cover (typographic fallback)',
    provider: 'ol',
    coverUrl: null,
    title: 'Dune',
    author: 'Frank Herbert',
    initials: 'D',
  },
];

function CoverImage({ url, initials, title }: { url: string | null; initials: string; title: string }) {
  const [failed, setFailed] = React.useState(false);

  const showFallback = !url || failed;

  if (!showFallback) {
    return (
      <div style={{
        width: 122, height: 180, borderRadius: 8,
        overflow: 'hidden', boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
        position: 'relative', zIndex: 2,
      }}>
        <img
          src={url}
          alt={title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <div style={{
      width: 122, height: 180, borderRadius: 8,
      overflow: 'hidden', backgroundColor: '#f5f1ec',
      boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
      position: 'relative', zIndex: 2,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 3, backgroundColor: '#7b9e7e', width: '100%' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{
          fontSize: initials.length > 1 ? 38 : 44,
          fontWeight: 700,
          color: '#6b635c',
          letterSpacing: initials.length > 1 ? 2 : 0.5,
          lineHeight: 1.1,
        }}>{initials}</span>
        <span style={{
          fontSize: 7, fontWeight: 600, color: '#9e958d',
          letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 5,
        }}>No cover</span>
      </div>
    </div>
  );
}

function BackButton() {
  return (
    <div style={{
      position: 'absolute', top: 76, left: 20, zIndex: 10,
      backgroundColor: 'rgba(255,255,255,0.82)', borderRadius: 20,
      padding: '5px 8px 5px 5px',
      display: 'flex', alignItems: 'center', gap: 1,
      fontSize: 15, color: '#78716c', fontWeight: 500,
      cursor: 'default',
    }}>
      ‹ Library
    </div>
  );
}

function HeroCard({ variant }: { variant: HeroVariant }) {
  const isGB = variant.provider === 'gb';
  const innerGlow = isGB ? GLOW_GB_INNER : GLOW_OL_INNER;
  const outerGlow = isGB ? GLOW_GB_OUTER : GLOW_OL_OUTER;

  return (
    <div style={{ width: 390, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ fontSize: 11, color: '#9e958d', marginBottom: 8, textAlign: 'center', letterSpacing: 0.3 }}>
        {variant.label}
      </div>

      {/* Hero section */}
      <div style={{ overflow: 'hidden', borderRadius: '14px 14px 0 0', position: 'relative' }}>
        <div style={{
          background: HERO_GRADIENT,
          paddingTop: 80, paddingBottom: 68,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}>
          {/* Tonal overlay */}
          <div style={{
            position: 'absolute', inset: 0,
            backgroundColor: OVERLAY_COLOR,
            pointerEvents: 'none',
          }} />

          {/* Outer radial glow */}
          <div style={{
            position: 'absolute',
            width: 260, height: 260, borderRadius: '50%',
            backgroundColor: outerGlow,
            top: '50%', left: '50%',
            transform: 'translate(-50%, calc(-50% + 10px))',
            pointerEvents: 'none',
          }} />

          {/* Inner radial glow */}
          <div style={{
            position: 'absolute',
            width: 160, height: 160, borderRadius: '50%',
            backgroundColor: innerGlow,
            top: '50%', left: '50%',
            transform: 'translate(-50%, calc(-50% + 10px))',
            pointerEvents: 'none',
          }} />

          <BackButton />

          <CoverImage url={variant.coverUrl} initials={variant.initials} title={variant.title} />
        </div>

        {/* Bottom fade */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 36,
          background: `linear-gradient(to bottom, rgba(238,233,226,0), ${PAGE_BG})`,
          pointerEvents: 'none',
        }} />
      </div>

      {/* Typography section */}
      <div style={{ backgroundColor: PAGE_BG, padding: '24px 24px 20px', borderRadius: '0 0 14px 14px' }}>
        <div style={{ fontSize: 27, fontWeight: 800, color: '#1e1b18', letterSpacing: -0.7, lineHeight: '34px', marginBottom: 5 }}>
          {variant.title}
        </div>
        <div style={{ fontSize: 15, color: '#6e6660', lineHeight: '22px', marginBottom: 8 }}>
          {variant.author}
        </div>
        {/* Edition line */}
        <div style={{ fontSize: 12, color: '#9e958d', marginBottom: 12 }}>
          Penguin Books · 2012 · 384 pages
          <span style={{ color: '#b5a99f', marginLeft: 4 }}>· Change edition</span>
        </div>
        {/* Status badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{
            backgroundColor: '#f0f9f4', borderRadius: 8,
            padding: '5px 12px', fontSize: 12, fontWeight: 600, color: '#16a34a',
          }}>
            Currently reading
          </div>
          <div style={{ fontSize: 13, color: '#9e958d', fontWeight: 500 }}>Edit</div>
        </div>
      </div>
    </div>
  );
}

import React from 'react';

export default function BookDetailHero() {
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#e8e4de',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 24px',
      gap: 40,
    }}>
      <div style={{ fontSize: 13, color: '#78716c', fontWeight: 500, letterSpacing: 0.3, textTransform: 'uppercase' }}>
        Hero Backdrop Redesign — Task #28 Validation
      </div>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
        {VARIANTS.map((v) => (
          <HeroCard key={v.label} variant={v} />
        ))}
      </div>
      {/* Comparison: before */}
      <div style={{ width: 390, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ fontSize: 11, color: '#9e958d', marginBottom: 8, textAlign: 'center', letterSpacing: 0.3 }}>
          Before — flat parchment #ede9e4
        </div>
        <div style={{ overflow: 'hidden', borderRadius: '14px 14px 0 0' }}>
          <div style={{
            backgroundColor: '#ede9e4',
            paddingTop: 80, paddingBottom: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute', top: 76, left: 20,
              backgroundColor: 'rgba(255,255,255,0.82)', borderRadius: 20,
              padding: '5px 8px 5px 5px', fontSize: 15, color: '#78716c',
            }}>‹ Library</div>
            <div style={{
              width: 122, height: 180, borderRadius: 8,
              overflow: 'hidden', backgroundColor: '#f5f1ec',
              boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ height: 3, backgroundColor: '#7b9e7e', width: '100%' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 44, fontWeight: 700, color: '#6b635c' }}>D</span>
                <span style={{ fontSize: 7, fontWeight: 600, color: '#9e958d', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 5 }}>No cover</span>
              </div>
            </div>
          </div>
        </div>
        <div style={{ backgroundColor: PAGE_BG, padding: '28px 24px 20px', borderRadius: '0 0 14px 14px' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#231f1b', letterSpacing: -0.6, lineHeight: '36px', marginBottom: 6 }}>Dune</div>
          <div style={{ fontSize: 15, color: '#78716c', lineHeight: '22px', marginBottom: 12 }}>Frank Herbert</div>
        </div>
      </div>
    </div>
  );
}
