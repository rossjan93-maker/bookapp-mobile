// Proof preview: Opening welcome screen
// Uses exact values from app/onboarding.tsx

export function IntroScreen() {
  const GREEN = '#15803d';
  const INK   = '#1c1917';
  const BG    = '#faf9f7';
  const SUB   = '#78716c';

  const SPINES = [
    { w: 54, h: 148, color: '#d6d0c8', rotate: '-7deg',  left: 110 },
    { w: 48, h: 162, color: '#b5c4b1', rotate:  '3deg',  left: 155 },
    { w: 58, h: 172, color: GREEN,     rotate: '-2deg',  left: 205 },
    { w: 44, h: 138, color: '#c9bdb0', rotate:  '8deg',  left: 257 },
  ];

  return (
    <div style={{
      width: 390, height: 844,
      backgroundColor: BG,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Status bar placeholder */}
      <div style={{ height: 50, width: '100%' }} />

      {/* Top skip button */}
      <div style={{
        alignSelf: 'flex-end',
        paddingRight: 22,
        paddingTop: 12,
        paddingBottom: 8,
      }}>
        <span style={{ fontSize: 14, color: SUB }}>Skip →</span>
      </div>

      {/* Book spines illustration */}
      <div style={{
        position: 'relative',
        width: '100%',
        height: 240,
        marginTop: 24,
        marginBottom: 8,
      }}>
        {SPINES.map((s, i) => (
          <div key={i} style={{
            position: 'absolute',
            width: s.w,
            height: s.h,
            borderRadius: 6,
            backgroundColor: s.color,
            left: s.left,
            top: '50%',
            transform: `translateY(-50%) rotate(${s.rotate})`,
            boxShadow: '0 6px 12px rgba(28,25,23,0.12)',
          }}>
            {/* Spine detail lines */}
            {[0, 1, 2].map(j => (
              <div key={j} style={{
                position: 'absolute',
                top: 16 + j * 9.5,
                left: 10,
                height: 1.5,
                borderRadius: 1,
                backgroundColor: s.color === GREEN ? 'rgba(255,255,255,0.18)' : 'rgba(28,25,23,0.1)',
                width: j === 0 ? '80%' : j === 1 ? '55%' : '70%',
              }} />
            ))}
          </div>
        ))}
      </div>

      {/* Brand + tagline */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingHorizontal: 36,
        gap: 0,
        flex: 1,
        justifyContent: 'center',
        marginTop: -16,
      }}>
        <span style={{
          fontSize: 42,
          fontWeight: 800,
          color: INK,
          letterSpacing: -1,
          lineHeight: 1,
        }}>
          readstack
        </span>

        {/* Green rule accent */}
        <div style={{
          width: 44,
          height: 3,
          borderRadius: 2,
          backgroundColor: GREEN,
          marginTop: 14,
          marginBottom: 20,
        }} />

        {/* ✅ VERIFIED SUBTITLE — exact string from app/onboarding.tsx line 322 */}
        <span style={{
          fontSize: 17,
          color: SUB,
          lineHeight: 1.53,
          textAlign: 'center',
          letterSpacing: 0.1,
          maxWidth: 280,
        }}>
          Your reading, together.
        </span>
      </div>

      {/* CTA button */}
      <div style={{
        width: '100%',
        paddingLeft: 22,
        paddingRight: 22,
        paddingBottom: 40,
      }}>
        <div style={{
          backgroundColor: INK,
          borderRadius: 16,
          paddingTop: 17,
          paddingBottom: 17,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <span style={{ color: BG, fontSize: 16, fontWeight: 800, letterSpacing: 0.2 }}>
            Show me around →
          </span>
        </div>
      </div>
    </div>
  );
}
