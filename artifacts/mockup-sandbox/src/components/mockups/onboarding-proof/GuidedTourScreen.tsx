// Proof preview: Guided tour — GuidedActionBanner shown in the recs feed context
// CARD constants mirror components/OnboardingWalkthrough.tsx exactly.
// OVER_TAB constant mirrors the shared bottom positioning.

export function GuidedTourScreen() {
  // CARD tokens — mirrored from OnboardingWalkthrough.tsx
  const CARD = {
    borderRadius:     14,
    paddingVertical:  14,
    paddingHorizontal: 16,
    gap:              12,
  };

  // OVER_TAB — shared constant used by GuidedNotedToast and GuidedLibraryBanner
  const OVER_TAB = 76;

  const INK  = '#1c1917';
  const BG   = '#faf9f7';
  const BORD = '#e7e5e4';
  const MUTED = '#a8a29e';
  const SUB  = '#78716c';

  return (
    <div style={{
      width: 390, height: 844,
      backgroundColor: BG,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Status bar */}
      <div style={{ height: 50 }} />

      {/* Tab header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 20,
        paddingRight: 20,
        height: 52,
        borderBottom: `1px solid ${BORD}`,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: INK }}>For You</span>
      </div>

      {/* Fake rec card #1 */}
      <div style={{
        margin: '12px 16px 0',
        backgroundColor: '#fff',
        borderRadius: 14,
        border: `1.5px solid ${BORD}`,
        padding: 16,
        display: 'flex',
        gap: 12,
      }}>
        <div style={{ width: 52, height: 76, borderRadius: 6, backgroundColor: '#e7e5e4' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>
            The Remains of the Day
          </div>
          <div style={{ fontSize: 13, color: SUB, marginBottom: 10 }}>Kazuo Ishiguro</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{
              backgroundColor: INK, borderRadius: 8, padding: '6px 12px',
            }}>
              <span style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>Save</span>
            </div>
            <div style={{
              border: `1.5px solid ${BORD}`, borderRadius: 8, padding: '6px 12px',
            }}>
              <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>Dismiss</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── GuidedActionBanner (Step 0) — inline, below first card ────────── */}
      {/* All CARD tokens applied consistently with GuidedNotedToast & GuidedLibraryBanner */}
      <div style={{
        margin:            '12px 16px 0',
        backgroundColor:   INK,
        borderRadius:      CARD.borderRadius,       // 14 — same as all banners
        paddingTop:        CARD.paddingVertical,     // 14 — same as all banners
        paddingBottom:     CARD.paddingVertical,
        paddingLeft:       CARD.paddingHorizontal,   // 16 — same as all banners
        paddingRight:      CARD.paddingHorizontal,
        display:           'flex',
        alignItems:        'center',
        gap:               CARD.gap,                 // 12 — same as all banners
        boxShadow:         '0 2px 8px rgba(0,0,0,0.10)',
      }}>
        <span style={{ fontSize: 19, color: MUTED }}>ℹ</span>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#faf9f7', fontSize: 13, fontWeight: 600, lineHeight: 1.38 }}>
            Save, dismiss, or tap "More like this"
          </div>
          <div style={{ color: MUTED, fontSize: 12, lineHeight: 1.42, marginTop: 2 }}>
            Every choice tunes your future picks
          </div>
        </div>
        <span style={{ color: '#a3e635', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          Got it
        </span>
      </div>

      {/* Fake rec card #2 (dimmed) */}
      <div style={{
        margin: '12px 16px 0',
        backgroundColor: '#fff',
        borderRadius: 14,
        border: `1.5px solid ${BORD}`,
        padding: 16,
        opacity: 0.45,
        display: 'flex',
        gap: 12,
      }}>
        <div style={{ width: 52, height: 76, borderRadius: 6, backgroundColor: '#e7e5e4' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Piranesi</div>
          <div style={{ fontSize: 13, color: SUB }}>Susanna Clarke</div>
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* ── Tab bar — sits at the bottom ────────────────────────────────── */}
      <div style={{
        height: OVER_TAB,
        borderTop: `1px solid ${BORD}`,
        backgroundColor: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingBottom: 8,
      }}>
        {['Home', 'For You', 'Library', 'Notes', 'Profile'].map(tab => (
          <div key={tab} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
          }}>
            <div style={{ width: 22, height: 22, backgroundColor: tab === 'For You' ? INK : BORD, borderRadius: 4 }} />
            <span style={{
              fontSize: 9,
              color: tab === 'For You' ? INK : MUTED,
              fontWeight: tab === 'For You' ? 700 : 400,
            }}>
              {tab}
            </span>
          </div>
        ))}
      </div>

      {/* ── GuidedLibraryBanner (Step 2) — floats at OVER_TAB px above tab bar */}
      {/* Rendered as overlay to show its placement at bottom: OVER_TAB = 76 */}
      <div style={{
        position:    'absolute',
        bottom:      OVER_TAB,          // ← OVER_TAB = 76 — shared with GuidedNotedToast
        left:        0,
        right:       0,
        paddingLeft: 16,
        paddingRight: 16,
        paddingBottom: 10,
      }}>
        <div style={{
          backgroundColor:   INK,
          borderRadius:      CARD.borderRadius,       // 14
          paddingTop:        CARD.paddingVertical,     // 14
          paddingBottom:     CARD.paddingVertical,
          paddingLeft:       CARD.paddingHorizontal,   // 16
          paddingRight:      CARD.paddingHorizontal,
          display:           'flex',
          alignItems:        'center',
          gap:               CARD.gap,                 // 12
          boxShadow:         '0 2px 8px rgba(0,0,0,0.10)',
          cursor:            'pointer',
          opacity:           0.9,
        }}>
          <span style={{ fontSize: 16, color: MUTED }}>📚</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#faf9f7', fontSize: 13, fontWeight: 600 }}>
              Your saved books are in Library
            </div>
            <div style={{ color: MUTED, fontSize: 12, marginTop: 1 }}>
              Tap Library below to explore
            </div>
          </div>
          <span style={{ color: SUB, fontSize: 14 }}>›</span>
        </div>
      </div>

    </div>
  );
}
