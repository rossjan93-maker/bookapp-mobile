// Proof preview: Question screen (IntakeTaste — "What tends to grip you?")
// Demonstrates the shared OnboardingShell layout system.
// All spacing values match OB constants from components/OnboardingShell.tsx exactly.

export function QuestionScreen() {
  // OB constants — mirrored exactly from components/OnboardingShell.tsx
  const OB = {
    padH:        20,
    padTop:      28,
    progressGap: 14,
    titleMB:     24,
    cardMB:      12,
    bottomGap:   16,
    bottomPadB:  32,
  };

  const INK   = '#1c1917';
  const MUTED = '#a8a29e';
  const DIM   = '#c4bfb9';
  const BORD  = '#e7e5e4';
  const BG    = '#faf9f7';
  const SUB   = '#78716c';

  const options = [
    { headline: 'Feeling & character',  sub: 'Emotional pull, relationships, inner lives', icon: '♥', isBoth: false },
    { headline: 'Ideas & perspective',  sub: 'Concepts, arguments, worldview shifts',      icon: '💡', isBoth: false },
    { headline: 'Both, honestly',       sub: 'Depends on the book and the mood',           icon: '↕', isBoth: true  },
  ];

  return (
    <div style={{
      width: 390, height: 844,
      backgroundColor: BG,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
    }}>
      {/* Status bar */}
      <div style={{ height: 50 }} />

      {/* ── SHELL HEADER ─────────────────────────────────────────────────── */}
      <div style={{
        paddingLeft:  OB.padH,
        paddingRight: OB.padH,
        paddingTop:   OB.padTop,   // ← OB.padTop = 28
      }}>
        {/* Progress row: outer step dots + sub-progress bars (stacked) */}
        <div style={{ marginBottom: OB.progressGap }}>  {/* ← OB.progressGap = 14 */}
          {/* Major step dots (genres · TASTE · anchor) — taste is step 1 (active) */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width:        i === 1 ? 22 : 6,
                height:       6,
                borderRadius: 3,
                backgroundColor: i <= 1 ? INK : BORD,
              }} />
            ))}
          </div>
          {/* Sub-progress: 3 taste questions — showing question 0 of 3 */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                flex:         1,
                height:       3,
                borderRadius: 2,
                backgroundColor: i <= 0 ? INK : BORD,
              }} />
            ))}
          </div>
        </div>

        {/* NOTE: IntakeTaste puts title inside children (animated with cards).
            This box shows that layout zone with the same OB.titleMB gap. */}
      </div>

      {/* ── SHELL CONTENT (flex: 1) ───────────────────────────────────────── */}
      <div style={{ flex: 1, paddingLeft: OB.padH, paddingRight: OB.padH, overflow: 'hidden' }}>
        {/* Question title — inside Animated.View in real code (slides on advance) */}
        <div style={{
          fontSize:      22,
          fontWeight:    800,
          color:         INK,
          lineHeight:    1.27,
          letterSpacing: -0.3,
          marginBottom:  OB.titleMB,  // ← OB.titleMB = 24
        }}>
          What tends to grip you?
        </div>

        {/* Option cards */}
        {options.map((opt, i) => (
          <div key={i} style={{
            backgroundColor: opt.isBoth ? BG : '#fff',
            borderRadius:    14,
            border:          `1.5px solid ${BORD}`,
            padding:         16,
            marginBottom:    OB.cardMB,   // ← OB.cardMB = 12
            display:         'flex',
            alignItems:      'center',
            gap:             12,
            cursor:          'pointer',
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: 19,
              backgroundColor: '#f5f5f4',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16,
              flexShrink: 0,
            }}>
              {opt.icon}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: opt.isBoth ? SUB : INK }}>
                {opt.headline}
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.42 }}>
                {opt.sub}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── SHELL BOTTOM ACTION ZONE ─────────────────────────────────────── */}
      {/* No primary button → skip links only. paddingBottom = OB.bottomPadB = 32 */}
      <div style={{
        paddingLeft:   OB.padH,
        paddingRight:  OB.padH,
        paddingBottom: OB.bottomPadB,   // ← OB.bottomPadB = 32
        display:       'flex',
        flexDirection: 'column',
        alignItems:    'center',
        gap:           OB.bottomGap,    // ← OB.bottomGap = 16
      }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: MUTED, cursor: 'pointer' }}>
          Skip this question →
        </span>
        <span style={{ fontSize: 13, color: DIM, cursor: 'pointer' }}>
          Skip remaining
        </span>
      </div>
    </div>
  );
}
